/**
 ****************************************************************************************************
 * @file        lwip_comm.c
 * @author      正点原子团队(ALIENTEK)
 * @version     V1.0
 * @date        2022-08-01
 * @brief       lwIP配置驱动
 * @license     Copyright (c) 2020-2032, 广州市星翼电子科技有限公司
 ****************************************************************************************************
 * @attention
 *
 * 参考平台:正点原子 阿波罗 F429开发板
 * 移植目标:野火 STM32F407 霸天虎 V2，LAN8720A
 * 在线视频:www.yuanzige.com
 * 技术论坛:www.openedv.com
 * 公司网址:www.alientek.com
 * 购买地址:openedv.taobao.com
 *
 * 修改说明
 * V1.0 20211202
 * 第一次发布
 *
 ****************************************************************************************************
 */

#include "lwip_comm.h"
#include "ethernetif.h"
#include "usart.h"
#include "stm32f4xx_hal.h"
#include "lwip/opt.h"
#include "lwip/tcpip.h"
#include "lwip/sys.h"
#include "lwip/dhcp.h"
#include "FreeRTOS.h"
#include "task.h"

#define LWIP_LINK_CHECK_INTERVAL_MS     100U
#define LWIP_LINK_TASK_PRIO             3
#define LWIP_LINK_STK_SIZE              384

#if LWIP_DHCP
#define LWIP_DHCP_CHECK_INTERVAL_MS     250U
#define LWIP_DHCP_TASK_PRIO             2
#define LWIP_DHCP_STK_SIZE              384
#endif

__lwip_dev g_lwipdev;
struct netif g_lwip_netif;
static uint8_t s_tcpip_initialized = 0;

static void lwip_link_thread(void *argument);

#if LWIP_DHCP
static volatile uint8_t g_lwip_dhcp_state = LWIP_DHCP_OFF;
static void lwip_dhcp_thread(void *argument);

static void lwip_dhcp_process(struct netif *netif)
{
    ip4_addr_t ipaddr;
    ip4_addr_t netmask;
    ip4_addr_t gateway;
    struct dhcp *dhcp;
    uint8_t log_event = 0;

    LOCK_TCPIP_CORE();
    switch (g_lwip_dhcp_state)
    {
        case LWIP_DHCP_START:
            ip4_addr_set_zero(&ipaddr);
            netif_set_addr(netif, &ipaddr, &ipaddr, &ipaddr);
            if (dhcp_start(netif) == ERR_OK)
            {
                g_lwipdev.dhcpstatus = 1;
                g_lwip_dhcp_state = LWIP_DHCP_WAIT_ADDRESS;
                log_event = 1;
            }
            break;

        case LWIP_DHCP_WAIT_ADDRESS:
        case LWIP_DHCP_ADDRESS_ASSIGNED:
            if (dhcp_supplied_address(netif))
            {
                uint8_t newly_assigned = (g_lwip_dhcp_state != LWIP_DHCP_ADDRESS_ASSIGNED);
                g_lwip_dhcp_state = LWIP_DHCP_ADDRESS_ASSIGNED;
                g_lwipdev.dhcpstatus = 2;
                g_lwipdev.ip[0] = ip4_addr1(netif_ip4_addr(netif));
                g_lwipdev.ip[1] = ip4_addr2(netif_ip4_addr(netif));
                g_lwipdev.ip[2] = ip4_addr3(netif_ip4_addr(netif));
                g_lwipdev.ip[3] = ip4_addr4(netif_ip4_addr(netif));
                g_lwipdev.netmask[0] = ip4_addr1(netif_ip4_netmask(netif));
                g_lwipdev.netmask[1] = ip4_addr2(netif_ip4_netmask(netif));
                g_lwipdev.netmask[2] = ip4_addr3(netif_ip4_netmask(netif));
                g_lwipdev.netmask[3] = ip4_addr4(netif_ip4_netmask(netif));
                g_lwipdev.gateway[0] = ip4_addr1(netif_ip4_gw(netif));
                g_lwipdev.gateway[1] = ip4_addr2(netif_ip4_gw(netif));
                g_lwipdev.gateway[2] = ip4_addr3(netif_ip4_gw(netif));
                g_lwipdev.gateway[3] = ip4_addr4(netif_ip4_gw(netif));
                if (newly_assigned)
                {
                    log_event = 2;
                }
            }
            else
            {
                g_lwipdev.dhcpstatus = 1;
                dhcp = netif_dhcp_data(netif);
                if ((dhcp != NULL) && (dhcp->tries > LWIP_MAX_DHCP_TRIES))
                {
                    dhcp_stop(netif);
                    lwip_comm_default_ip_set(&g_lwipdev);
                    IP4_ADDR(&ipaddr, g_lwipdev.ip[0], g_lwipdev.ip[1], g_lwipdev.ip[2], g_lwipdev.ip[3]);
                    IP4_ADDR(&netmask, g_lwipdev.netmask[0], g_lwipdev.netmask[1], g_lwipdev.netmask[2], g_lwipdev.netmask[3]);
                    IP4_ADDR(&gateway, g_lwipdev.gateway[0], g_lwipdev.gateway[1], g_lwipdev.gateway[2], g_lwipdev.gateway[3]);
                    netif_set_addr(netif, &ipaddr, &netmask, &gateway);
                    g_lwipdev.dhcpstatus = 0xFF;
                    g_lwip_dhcp_state = LWIP_DHCP_TIMEOUT;
                    log_event = 3;
                }
            }
            break;

        case LWIP_DHCP_LINK_DOWN:
            dhcp_stop(netif);
            ip4_addr_set_zero(&ipaddr);
            netif_set_addr(netif, &ipaddr, &ipaddr, &ipaddr);
            g_lwipdev.dhcpstatus = 0;
            g_lwip_dhcp_state = LWIP_DHCP_OFF;
            log_event = 4;
            break;

        default:
            break;
    }
    UNLOCK_TCPIP_CORE();

    if (log_event == 1)
    {
        usart_printf("[NET] DHCP started, waiting for IP...\r\n");
    }
    else if (log_event == 2)
    {
        usart_printf("[NET] DHCP IP: %u.%u.%u.%u, Mask: %u.%u.%u.%u, GW: %u.%u.%u.%u\r\n",
                     g_lwipdev.ip[0], g_lwipdev.ip[1], g_lwipdev.ip[2], g_lwipdev.ip[3],
                     g_lwipdev.netmask[0], g_lwipdev.netmask[1], g_lwipdev.netmask[2], g_lwipdev.netmask[3],
                     g_lwipdev.gateway[0], g_lwipdev.gateway[1], g_lwipdev.gateway[2], g_lwipdev.gateway[3]);
    }
    else if (log_event == 3)
    {
        usart_printf("[NET] DHCP timeout, static IP: %u.%u.%u.%u, Mask: %u.%u.%u.%u, GW: %u.%u.%u.%u\r\n",
                     g_lwipdev.ip[0], g_lwipdev.ip[1], g_lwipdev.ip[2], g_lwipdev.ip[3],
                     g_lwipdev.netmask[0], g_lwipdev.netmask[1], g_lwipdev.netmask[2], g_lwipdev.netmask[3],
                     g_lwipdev.gateway[0], g_lwipdev.gateway[1], g_lwipdev.gateway[2], g_lwipdev.gateway[3]);
    }
    else if (log_event == 4)
    {
        usart_printf("[NET] DHCP stopped (link down)\r\n");
    }
}

static void lwip_dhcp_thread(void *argument)
{
    struct netif *netif = (struct netif *)argument;

    for (;;)
    {
        lwip_dhcp_process(netif);
        vTaskDelay(pdMS_TO_TICKS(LWIP_DHCP_CHECK_INTERVAL_MS));
    }
}
#endif

void lwip_comm_default_ip_set(__lwip_dev *lwipx)
{
    uint32_t uid = HAL_GetUIDw0() ^ HAL_GetUIDw1() ^ HAL_GetUIDw2();

    /* 使用本地管理的单播 MAC，后 5 字节由 STM32 唯一 ID 派生。 */
    lwipx->mac[0] = 0x02;
    lwipx->mac[1] = (uint8_t)(HAL_GetUIDw1() >> 8);
    lwipx->mac[2] = (uint8_t)(uid >> 24);
    lwipx->mac[3] = (uint8_t)(uid >> 16);
    lwipx->mac[4] = (uint8_t)(uid >> 8);
    lwipx->mac[5] = (uint8_t)uid;

    lwipx->remoteip[0] = 192;
    lwipx->remoteip[1] = 168;
    lwipx->remoteip[2] = 1;
    lwipx->remoteip[3] = 134;
    lwipx->ip[0] = 192;
    lwipx->ip[1] = 168;
    lwipx->ip[2] = 1;
    lwipx->ip[3] = 30;
    lwipx->netmask[0] = 255;
    lwipx->netmask[1] = 255;
    lwipx->netmask[2] = 255;
    lwipx->netmask[3] = 0;
    lwipx->gateway[0] = 192;
    lwipx->gateway[1] = 168;
    lwipx->gateway[2] = 1;
    lwipx->gateway[3] = 1;
    lwipx->dhcpstatus = 0;
    lwipx->link_status = LWIP_LINK_OFF;
}

uint8_t lwip_comm_init(void)
{
    ip4_addr_t ipaddr;
    ip4_addr_t netmask;
    ip4_addr_t gateway;
    struct netif *added_netif;

    lwip_comm_default_ip_set(&g_lwipdev);
    if (!s_tcpip_initialized)
    {
        tcpip_init(NULL, NULL);
        s_tcpip_initialized = 1;
    }

#if LWIP_DHCP
    ip4_addr_set_zero(&ipaddr);
    ip4_addr_set_zero(&netmask);
    ip4_addr_set_zero(&gateway);
#else
    IP4_ADDR(&ipaddr, g_lwipdev.ip[0], g_lwipdev.ip[1], g_lwipdev.ip[2], g_lwipdev.ip[3]);
    IP4_ADDR(&netmask, g_lwipdev.netmask[0], g_lwipdev.netmask[1], g_lwipdev.netmask[2], g_lwipdev.netmask[3]);
    IP4_ADDR(&gateway, g_lwipdev.gateway[0], g_lwipdev.gateway[1], g_lwipdev.gateway[2], g_lwipdev.gateway[3]);
#endif

    LOCK_TCPIP_CORE();
    added_netif = netif_add(&g_lwip_netif, &ipaddr, &netmask, &gateway, NULL, ethernetif_init, tcpip_input);
    if (added_netif == NULL)
    {
        UNLOCK_TCPIP_CORE();
        return 1;
    }

    netif_set_default(&g_lwip_netif);
    netif_set_link_callback(&g_lwip_netif, lwip_link_status_updated);
    netif_set_up(&g_lwip_netif);
    UNLOCK_TCPIP_CORE();

    ethernetif_link_check_state(&g_lwip_netif);

    sys_thread_new("eth_link",
                   lwip_link_thread,
                   &g_lwip_netif,
                   LWIP_LINK_STK_SIZE,
                   LWIP_LINK_TASK_PRIO);

#if LWIP_DHCP
    sys_thread_new("eth_dhcp",
                   lwip_dhcp_thread,
                   &g_lwip_netif,
                   LWIP_DHCP_STK_SIZE,
                   LWIP_DHCP_TASK_PRIO);
#endif

    usart_printf("[ETH] lwIP(FreeRTOS) init ok, MAC: %02X:%02X:%02X:%02X:%02X:%02X, Link: %s\r\n",
                 g_lwipdev.mac[0], g_lwipdev.mac[1], g_lwipdev.mac[2],
                 g_lwipdev.mac[3], g_lwipdev.mac[4], g_lwipdev.mac[5],
                 netif_is_link_up(&g_lwip_netif) ? "UP" : "DOWN");
#if LWIP_DHCP
    usart_printf("[NET] Mode: DHCP\r\n");
#else
    usart_printf("[NET] Mode: Static, IP: %u.%u.%u.%u, Mask: %u.%u.%u.%u, GW: %u.%u.%u.%u\r\n",
                 g_lwipdev.ip[0], g_lwipdev.ip[1], g_lwipdev.ip[2], g_lwipdev.ip[3],
                 g_lwipdev.netmask[0], g_lwipdev.netmask[1], g_lwipdev.netmask[2], g_lwipdev.netmask[3],
                 g_lwipdev.gateway[0], g_lwipdev.gateway[1], g_lwipdev.gateway[2], g_lwipdev.gateway[3]);
#endif
    return 0;
}

void lwip_link_status_updated(struct netif *netif)
{
    if (netif_is_link_up(netif))
    {
        g_lwipdev.link_status = LWIP_LINK_ON;
#if LWIP_DHCP
        g_lwip_dhcp_state = LWIP_DHCP_START;
#endif
    }
    else
    {
        g_lwipdev.link_status = LWIP_LINK_OFF;
#if LWIP_DHCP
        g_lwip_dhcp_state = LWIP_DHCP_LINK_DOWN;
#endif
    }
}

static void lwip_link_thread(void *argument)
{
    struct netif *netif = (struct netif *)argument;

    for (;;)
    {
        ethernetif_link_check_state(netif);
        vTaskDelay(pdMS_TO_TICKS(LWIP_LINK_CHECK_INTERVAL_MS));
    }
}
