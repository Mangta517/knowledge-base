/**
  ******************************************************************************
  * @file    LwIP/LwIP_HTTP_Server_Raw/Src/ethernetif.c
  * @author  MCD Application Team
  * @brief   This file implements Ethernet network interface drivers for lwIP
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2017 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */

#include "ethernetif.h"
#include "ethernet.h"
#include "ethernet_chip.h"
#include "lwip_comm.h"
#include "usart.h"
#include "lwip/opt.h"
#include "lwip/pbuf.h"
#include "lwip/memp.h"
#include "lwip/sys.h"
#include "lwip/tcpip.h"
#include "netif/etharp.h"
#include "FreeRTOS.h"
#include "semphr.h"
#include "task.h"
#include <stddef.h>

#define ETH_DMA_TRANSMIT_TIMEOUT_MS     20U
#define ETH_RX_BUFFER_CNT               10U
#define INTERFACE_THREAD_STACK_SIZE     512
#define NETIF_IN_TASK_PRIORITY          (TCPIP_THREAD_PRIO + 1)

typedef enum
{
    RX_ALLOC_OK = 0x00,
    RX_ALLOC_ERROR = 0x01
} rx_alloc_status_t;

/* F407 没有数据缓存，DMA 缓冲按 4 字节对齐即可。 */
typedef struct
{
    struct pbuf_custom pbuf_custom;
    uint8_t buff[ETH_RX_BUFFER_SIZE] __ALIGNED(4);
} ethernet_rx_buffer_struct;

LWIP_MEMPOOL_DECLARE(RX_POOL, ETH_RX_BUFFER_CNT, sizeof(ethernet_rx_buffer_struct), "Ethernet RX pool");

static eth_chip_object_t eth_chip;
static int32_t eth_link_state = ETH_CHIP_STATUS_LINK_DOWN;
static uint8_t eth_tx_buffer[ETH_TX_DESC_CNT][ETH_RX_BUFFER_SIZE] __ALIGNED(4);
static volatile uint8_t s_rx_alloc_status = RX_ALLOC_OK;
static SemaphoreHandle_t s_rx_semaphore = NULL;
static SemaphoreHandle_t s_tx_semaphore = NULL;
static uint8_t s_eth_input_task_created = 0;

static void ethernetif_input(void *argument);

static int32_t eth_phy_io_init(void)
{
    HAL_ETH_SetMDIOClockRange(&g_eth_handler);
    return 0;
}

static int32_t eth_phy_io_read_reg(uint32_t address, uint32_t reg, uint32_t *value)
{
    if (HAL_ETH_ReadPHYRegister(&g_eth_handler, address, reg, value) != HAL_OK)
    {
        return -1;
    }
    return 0;
}

static int32_t eth_phy_io_write_reg(uint32_t address, uint32_t reg, uint32_t value)
{
    if (HAL_ETH_WritePHYRegister(&g_eth_handler, address, reg, value) != HAL_OK)
    {
        return -1;
    }
    return 0;
}

static int32_t eth_phy_io_get_tick(void)
{
    return (int32_t)HAL_GetTick();
}

static void pbuf_free_custom(struct pbuf *p)
{
    LWIP_MEMPOOL_FREE(RX_POOL, p);

    /* 若 RX 缓冲池此前耗尽，释放后唤醒收包线程重新挂载 DMA 描述符。 */
    if (s_rx_alloc_status == RX_ALLOC_ERROR)
    {
        s_rx_alloc_status = RX_ALLOC_OK;
        if (s_rx_semaphore != NULL)
        {
            if (xPortIsInsideInterrupt() == pdTRUE)
            {
                BaseType_t task_woken = pdFALSE;
                if (xSemaphoreGiveFromISR(s_rx_semaphore, &task_woken) == pdTRUE)
                {
                    portYIELD_FROM_ISR(task_woken);
                }
            }
            else
            {
                (void)xSemaphoreGive(s_rx_semaphore);
            }
        }
    }
}

static err_t low_level_output(struct netif *netif, struct pbuf *p)
{
    ETH_BufferTypeDef tx_buffer = {0};
    ETH_TxPacketConfigTypeDef tx_config = {0};
    uint32_t index;

    if (!netif_is_link_up(netif))
    {
        return ERR_RTE;
    }

    if (p->tot_len > ETH_RX_BUFFER_SIZE)
    {
        return ERR_BUF;
    }

    HAL_ETH_ReleaseTxPacket(&g_eth_handler);
    index = g_eth_handler.TxDescList.CurTxDesc;

    if (((g_eth_handler.Init.TxDesc[index].DESC0 & ETH_DMATXDESC_OWN) != 0U) ||
        (g_eth_handler.TxDescList.PacketAddress[index] != NULL))
    {
        return ERR_WOULDBLOCK;
    }

    /* 合并 pbuf 链到描述符独占的 SRAM 缓冲，避免 pbuf 生命周期或 CCM 地址影响 DMA。 */
    if (pbuf_copy_partial(p, eth_tx_buffer[index], p->tot_len, 0) != p->tot_len)
    {
        return ERR_BUF;
    }

    tx_buffer.buffer = eth_tx_buffer[index];
    tx_buffer.len = p->tot_len;
    /* 全硬件校验模式下显式启用 TX 描述符 IP/TCP/UDP/ICMP 校验和插入。 */
    tx_config.Attributes = ETH_TX_PACKETS_FEATURES_CSUM | ETH_TX_PACKETS_FEATURES_CRCPAD;
    tx_config.ChecksumCtrl = ETH_CHECKSUM_IPHDR_PAYLOAD_INSERT_PHDR_CALC;
    tx_config.CRCPadCtrl = ETH_CRC_PAD_INSERT;
    tx_config.Length = p->tot_len;
    tx_config.TxBuffer = &tx_buffer;
    /* pData 非 NULL，确保 HAL_ETH_ReleaseTxPacket 正确回收描述符与 BuffersInUse。 */
    tx_config.pData = eth_tx_buffer[index];

    if (s_tx_semaphore != NULL)
    {
        (void)xSemaphoreTake(s_tx_semaphore, 0);
    }

    if (HAL_ETH_Transmit_IT(&g_eth_handler, &tx_config) != HAL_OK)
    {
        return ERR_IF;
    }

    if (xSemaphoreTake(s_tx_semaphore, pdMS_TO_TICKS(ETH_DMA_TRANSMIT_TIMEOUT_MS)) != pdTRUE)
    {
        HAL_ETH_ReleaseTxPacket(&g_eth_handler);
        return ERR_IF;
    }

    HAL_ETH_ReleaseTxPacket(&g_eth_handler);
    return ERR_OK;
}

err_t ethernetif_init(struct netif *netif)
{
    uint32_t index;
    ETH_MACConfigTypeDef mac_config = {0};
    eth_chip_ioc_tx_t phy_io = {eth_phy_io_init, NULL, eth_phy_io_write_reg, eth_phy_io_read_reg, eth_phy_io_get_tick};

    LWIP_ASSERT("netif != NULL", (netif != NULL));

    netif->name[0] = 's';
    netif->name[1] = 't';
    netif->hwaddr_len = ETH_HWADDR_LEN;
    for (index = 0; index < ETH_HWADDR_LEN; index++)
    {
        netif->hwaddr[index] = g_lwipdev.mac[index];
    }
    netif->mtu = 1500;
    netif->flags = NETIF_FLAG_BROADCAST | NETIF_FLAG_ETHARP;
    netif->output = etharp_output;
    netif->linkoutput = low_level_output;

    LWIP_MEMPOOL_INIT(RX_POOL);
    s_rx_alloc_status = RX_ALLOC_OK;

    if (ethernet_init(netif->hwaddr) != 0)
    {
        usart_printf("[ETH] MAC init failed\r\n");
        return ERR_IF;
    }

    if ((eth_chip_regster_bus_io(&eth_chip, &phy_io) != ETH_CHIP_STATUS_OK) ||
        (eth_chip_init(&eth_chip) != ETH_CHIP_STATUS_OK) ||
        (eth_chip_start_auto_nego(&eth_chip) != ETH_CHIP_STATUS_OK))
    {
        usart_printf("[ETH] PHY LAN8720A init failed\r\n");
        return ERR_IF;
    }

    /* 开启 MAC 接收端硬件校验和卸载，与 lwipopts.h 的 CHECKSUM_CHECK_* = 0 保持一致。 */
    HAL_ETH_GetMACConfig(&g_eth_handler, &mac_config);
    mac_config.ChecksumOffload = ENABLE;
    if (HAL_ETH_SetMACConfig(&g_eth_handler, &mac_config) != HAL_OK)
    {
        return ERR_IF;
    }

    if (s_rx_semaphore == NULL)
    {
        s_rx_semaphore = xSemaphoreCreateBinary();
        if (s_rx_semaphore == NULL)
        {
            return ERR_MEM;
        }
    }

    if (s_tx_semaphore == NULL)
    {
        s_tx_semaphore = xSemaphoreCreateBinary();
        if (s_tx_semaphore == NULL)
        {
            return ERR_MEM;
        }
    }

    if (!s_eth_input_task_created)
    {
        sys_thread_new("eth_thread",
                       ethernetif_input,
                       netif,
                       INTERFACE_THREAD_STACK_SIZE,
                       NETIF_IN_TASK_PRIORITY);
        s_eth_input_task_created = 1;
    }

    return ERR_OK;
}

void ethernetif_link_check_state(struct netif *netif)
{
    int32_t link_state = eth_chip_get_link_state(&eth_chip);
    ETH_MACConfigTypeDef mac_config = {0};

    if ((link_state < ETH_CHIP_STATUS_100MBITS_FULLDUPLEX) || (link_state > ETH_CHIP_STATUS_10MBITS_HALFDUPLEX))
    {
        if (netif_is_link_up(netif))
        {
            LOCK_TCPIP_CORE();
            netif_set_link_down(netif);
            HAL_ETH_Stop_IT(&g_eth_handler);
            UNLOCK_TCPIP_CORE();
            usart_printf("[ETH] Link DOWN\r\n");
        }
        eth_link_state = link_state;
        return;
    }

    if (netif_is_link_up(netif) && (link_state == eth_link_state))
    {
        return;
    }

    LOCK_TCPIP_CORE();
    if (netif_is_link_up(netif))
    {
        netif_set_link_down(netif);
        HAL_ETH_Stop_IT(&g_eth_handler);
    }

    HAL_ETH_GetMACConfig(&g_eth_handler, &mac_config);
    if ((link_state == ETH_CHIP_STATUS_100MBITS_FULLDUPLEX) || (link_state == ETH_CHIP_STATUS_100MBITS_HALFDUPLEX))
    {
        mac_config.Speed = ETH_SPEED_100M;
    }
    else
    {
        mac_config.Speed = ETH_SPEED_10M;
    }

    if ((link_state == ETH_CHIP_STATUS_100MBITS_FULLDUPLEX) || (link_state == ETH_CHIP_STATUS_10MBITS_FULLDUPLEX))
    {
        mac_config.DuplexMode = ETH_FULLDUPLEX_MODE;
    }
    else
    {
        mac_config.DuplexMode = ETH_HALFDUPLEX_MODE;
    }

    if ((HAL_ETH_SetMACConfig(&g_eth_handler, &mac_config) == HAL_OK) && (HAL_ETH_Start_IT(&g_eth_handler) == HAL_OK))
    {
        eth_link_state = link_state;
        netif_set_link_up(netif);
        UNLOCK_TCPIP_CORE();
        usart_printf("[ETH] Link UP (%s, %s)\r\n",
                     (mac_config.Speed == ETH_SPEED_100M) ? "100M" : "10M",
                     (mac_config.DuplexMode == ETH_FULLDUPLEX_MODE) ? "Full Duplex" : "Half Duplex");
    }
    else
    {
        UNLOCK_TCPIP_CORE();
    }
}

static void ethernetif_input(void *argument)
{
    struct netif *netif = (struct netif *)argument;
    struct pbuf *p;
    uint32_t errors;

    for (;;)
    {
        if (xSemaphoreTake(s_rx_semaphore, portMAX_DELAY) == pdTRUE)
        {
            do
            {
                p = NULL;
                if (s_rx_alloc_status == RX_ALLOC_OK)
                {
                    HAL_ETH_ReadData(&g_eth_handler, (void **)&p);
                }

                if (p != NULL)
                {
                    HAL_ETH_GetRxDataErrorCode(&g_eth_handler, &errors);
                    if ((errors & ETH_DMARXDESC_ES) != 0U)
                    {
                        pbuf_free(p);
                    }
                    else if (netif->input(p, netif) != ERR_OK)
                    {
                        pbuf_free(p);
                    }
                }
            } while (p != NULL);
        }
    }
}

void HAL_ETH_RxCpltCallback(ETH_HandleTypeDef *heth)
{
    BaseType_t task_woken = pdFALSE;

    (void)heth;
    if (s_rx_semaphore != NULL)
    {
        if (xSemaphoreGiveFromISR(s_rx_semaphore, &task_woken) == pdTRUE)
        {
            portYIELD_FROM_ISR(task_woken);
        }
    }
}

void HAL_ETH_TxCpltCallback(ETH_HandleTypeDef *heth)
{
    BaseType_t task_woken = pdFALSE;

    (void)heth;
    if (s_tx_semaphore != NULL)
    {
        if (xSemaphoreGiveFromISR(s_tx_semaphore, &task_woken) == pdTRUE)
        {
            portYIELD_FROM_ISR(task_woken);
        }
    }
}

void HAL_ETH_ErrorCallback(ETH_HandleTypeDef *heth)
{
    if ((HAL_ETH_GetDMAError(heth) & ETH_DMASR_RBUS) == ETH_DMASR_RBUS)
    {
        BaseType_t task_woken = pdFALSE;
        if ((s_rx_semaphore != NULL) && (xSemaphoreGiveFromISR(s_rx_semaphore, &task_woken) == pdTRUE))
        {
            portYIELD_FROM_ISR(task_woken);
        }
    }
}

void HAL_ETH_TxFreeCallback(uint32_t *buff)
{
    (void)buff;
}

void HAL_ETH_RxAllocateCallback(uint8_t **buff)
{
    struct pbuf_custom *p = LWIP_MEMPOOL_ALLOC(RX_POOL);

    if (p != NULL)
    {
        *buff = (uint8_t *)p + offsetof(ethernet_rx_buffer_struct, buff);
        p->custom_free_function = pbuf_free_custom;
        pbuf_alloced_custom(PBUF_RAW, 0, PBUF_REF, p, *buff, ETH_RX_BUFFER_SIZE);
    }
    else
    {
        s_rx_alloc_status = RX_ALLOC_ERROR;
        *buff = NULL;
    }
}

void HAL_ETH_RxLinkCallback(void **p_start, void **p_end, uint8_t *buff, uint16_t length)
{
    struct pbuf **start = (struct pbuf **)p_start;
    struct pbuf **end = (struct pbuf **)p_end;
    struct pbuf *p = (struct pbuf *)(buff - offsetof(ethernet_rx_buffer_struct, buff));

    p->next = NULL;
    p->len = length;
    p->tot_len = 0;

    if (*start == NULL)
    {
        *start = p;
    }
    else
    {
        (*end)->next = p;
    }
    *end = p;

    for (p = *start; p != NULL; p = p->next)
    {
        p->tot_len += length;
    }
}
