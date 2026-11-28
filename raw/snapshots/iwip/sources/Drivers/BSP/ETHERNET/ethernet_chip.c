/**
 ****************************************************************************************************
 * @file        ethernet_chip.c
 * @author      正点原子团队(ALIENTEK)
 * @version     V1.0
 * @date        2022-08-01
 * @brief       PHY芯片配置驱动
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
 * V1.0 20220420
 * 第一次发布
 *
 ****************************************************************************************************
 */
#include "ethernet_chip.h"


#define ETH_CHIP_SW_RESET_TO    ((uint32_t)500U)    /* 软件复位等待时间 */
#define ETH_CHIP_INIT_TO        ((uint32_t)2000U)   /* 初始化等待时间 */
#define ETH_CHIP_MAX_DEV_ADDR   ((uint32_t)31U)     /* PHY地址的最大值 */


/**
  * @brief       将IO函数注册到组件对象
  * @param       pobj：设备对象
  * @param       ioctx：保存设备IO功能 
  * @retval      ETH_CHIP_STATUS_OK：OK
  *              ETH_CHIP_STATUS_ERROR：缺少功能
  */
int32_t  eth_chip_regster_bus_io(eth_chip_object_t *pobj, eth_chip_ioc_tx_t *ioctx)
{
    if (!pobj || !ioctx->readreg || !ioctx->writereg || !ioctx->gettick)
    {
        return ETH_CHIP_STATUS_ERROR;
    }

    pobj->io.init = ioctx->init;
    pobj->io.deinit = ioctx->deinit;
    pobj->io.readreg = ioctx->readreg;
    pobj->io.writereg = ioctx->writereg;
    pobj->io.gettick = ioctx->gettick;

    return ETH_CHIP_STATUS_OK;
}

/**
  * @brief       初始化ETH_CHIP并配置所需的硬件资源
  * @param       pobj: 设备对象
  * @retval      ETH_CHIP_STATUS_OK：初始化ETH_CHIP并配置所需的硬件资源成功
                 ETH_CHIP_STATUS_ADDRESS_ERROR：找不到设备地址
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR：不能写入寄存器
                 ETH_CHIP_STATUS_RESET_TIMEOUT：无法执行软件复位
  */
int32_t eth_chip_init(eth_chip_object_t *pobj)
{
    uint32_t phy_id1;
    uint32_t phy_id2;
    uint32_t regvalue;
    uint32_t tickstart;
    uint32_t addr;

    if (pobj->is_initialized != 0)
    {
        return ETH_CHIP_STATUS_OK;
    }

    if ((pobj->io.init != 0) && (pobj->io.init() < 0))
    {
        return ETH_CHIP_STATUS_ERROR;
    }

    pobj->devaddr = ETH_CHIP_MAX_DEV_ADDR + 1;

    /* 通过 PHY ID 识别 LAN8720A；寄存器 31 的低 5 位不是 PHY 地址。 */
    for (addr = 0; addr <= ETH_CHIP_MAX_DEV_ADDR; addr++)
    {
        if ((pobj->io.readreg(addr, ETH_CHIP_PHYID1, &phy_id1) < 0) ||
            (pobj->io.readreg(addr, ETH_CHIP_PHYID2, &phy_id2) < 0))
        {
            continue;
        }

        if ((phy_id1 == ETH_CHIP_PHYID1_VALUE) && ((phy_id2 & ETH_CHIP_PHYID2_MASK) == ETH_CHIP_PHYID2_VALUE))
        {
            pobj->devaddr = addr;
            break;
        }
    }

    if (pobj->devaddr > ETH_CHIP_MAX_DEV_ADDR)
    {
        return ETH_CHIP_STATUS_ADDRESS_ERROR;
    }

    if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, ETH_CHIP_BCR_SOFT_RESET) < 0)
    {
        return ETH_CHIP_STATUS_WRITE_ERROR;
    }

    tickstart = (uint32_t)pobj->io.gettick();
    do
    {
        if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &regvalue) < 0)
        {
            return ETH_CHIP_STATUS_READ_ERROR;
        }

        if (((uint32_t)pobj->io.gettick() - tickstart) > ETH_CHIP_SW_RESET_TO)
        {
            return ETH_CHIP_STATUS_RESET_TIMEOUT;
        }
    } while ((regvalue & ETH_CHIP_BCR_SOFT_RESET) != 0);

    pobj->is_initialized = 1;
    return ETH_CHIP_STATUS_OK;
}

/**
  * @brief       反初始化ETH_CHIP及其硬件资源
  * @param       pobj: 设备对象
  * @retval      ETH_CHIP_STATUS_OK：反初始化失败成功
                 ETH_CHIP_STATUS_ERROR：反初始化失败
  */
int32_t eth_chip_deinit(eth_chip_object_t *pobj)
{
    if (pobj->is_initialized)
    {
        if (pobj->io.deinit != 0)
        {
            if (pobj->io.deinit() < 0)
            {
                return ETH_CHIP_STATUS_ERROR;
            }
        }

        pobj->is_initialized = 0;  
    }

    return ETH_CHIP_STATUS_OK;
}

/**
  * @brief       关闭ETH_CHIP的下电模式
  * @param       pobj: 设备对象
  * @retval      ETH_CHIP_STATUS_OK：关闭成功
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR：不能写寄存器
  */
int32_t eth_chip_disable_power_down_mode(eth_chip_object_t *pobj)
{
    uint32_t readval = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &readval) >= 0)
    {
        readval &= ~ETH_CHIP_BCR_POWER_DOWN;

        /* 清除下电模式 */
        if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, readval) < 0)
        {
            status =  ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    return status;
}

/**
  * @brief       使能ETH_CHIP的下电模式
  * @param       pobj: 设备对象
  * @retval      ETH_CHIP_STATUS_OK：关闭成功
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR：不能写寄存器
  */
int32_t eth_chip_enable_power_down_mode(eth_chip_object_t *pobj)
{
    uint32_t readval = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &readval) >= 0)
    {
        readval |= ETH_CHIP_BCR_POWER_DOWN;

        /* 使能下电模式 */
        if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, readval) < 0)
        {
            status =  ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    return status;
}

/**
  * @brief       启动自动协商过程
  * @param       pobj: 设备对象
  * @retval      ETH_CHIP_STATUS_OK：关闭成功
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR：不能写寄存器
  */
int32_t eth_chip_start_auto_nego(eth_chip_object_t *pobj)
{
    uint32_t readval = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &readval) >= 0)
    {
        readval |= ETH_CHIP_BCR_AUTONEGO_EN | ETH_CHIP_BCR_RESTART_AUTONEGO;

        /* 启动自动协商 */
        if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, readval) < 0)
        {
            status =  ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    return status;
}

/**
  * @brief       获取ETH_CHIP设备的链路状态
  * @param       pobj: 设备对象
  * @param       pLinkState: 指向链路状态的指针
  * @retval      ETH_CHIP_STATUS_100MBITS_FULLDUPLEX：100M，全双工
                 ETH_CHIP_STATUS_100MBITS_HALFDUPLEX ：100M，半双工
                 ETH_CHIP_STATUS_10MBITS_FULLDUPLEX：10M，全双工
                 ETH_CHIP_STATUS_10MBITS_HALFDUPLEX ：10M，半双工
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
  */
int32_t eth_chip_get_link_state(eth_chip_object_t *pobj)
{
    uint32_t status;
    uint32_t control;

    /* BSR 的链路位为低电平锁存，连续读两次获取当前状态。 */
    if ((pobj->io.readreg(pobj->devaddr, ETH_CHIP_BSR, &status) < 0) ||
        (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BSR, &status) < 0))
    {
        return ETH_CHIP_STATUS_READ_ERROR;
    }

    if ((status & ETH_CHIP_BSR_LINK_STATUS) == 0)
    {
        return ETH_CHIP_STATUS_LINK_DOWN;
    }

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &control) < 0)
    {
        return ETH_CHIP_STATUS_READ_ERROR;
    }

    if ((control & ETH_CHIP_BCR_AUTONEGO_EN) == 0)
    {
        if ((control & ETH_CHIP_BCR_SPEED_SELECT) != 0)
        {
            if ((control & ETH_CHIP_BCR_DUPLEX_MODE) != 0)
            {
                return ETH_CHIP_STATUS_100MBITS_FULLDUPLEX;
            }
            return ETH_CHIP_STATUS_100MBITS_HALFDUPLEX;
        }

        if ((control & ETH_CHIP_BCR_DUPLEX_MODE) != 0)
        {
            return ETH_CHIP_STATUS_10MBITS_FULLDUPLEX;
        }
        return ETH_CHIP_STATUS_10MBITS_HALFDUPLEX;
    }

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_PHYSCSR, &status) < 0)
    {
        return ETH_CHIP_STATUS_READ_ERROR;
    }

    if ((status & ETH_CHIP_PHYSCSR_AUTONEGO_DONE) == 0)
    {
        return ETH_CHIP_STATUS_AUTONEGO_NOTDONE;
    }

    switch (status & ETH_CHIP_PHYSCSR_HCDSPEED_MASK)
    {
        case ETH_CHIP_PHYSCSR_100M_FULL:
            return ETH_CHIP_STATUS_100MBITS_FULLDUPLEX;
        case ETH_CHIP_PHYSCSR_100M_HALF:
            return ETH_CHIP_STATUS_100MBITS_HALFDUPLEX;
        case ETH_CHIP_PHYSCSR_10M_FULL:
            return ETH_CHIP_STATUS_10MBITS_FULLDUPLEX;
        case ETH_CHIP_PHYSCSR_10M_HALF:
            return ETH_CHIP_STATUS_10MBITS_HALFDUPLEX;
        default:
            return ETH_CHIP_STATUS_AUTONEGO_NOTDONE;
    }
}

/**
  * @brief       设置ETH_CHIP设备的链路状态
  * @param       pobj: 设备对象
  * @param       pLinkState: 指向链路状态的指针
  * @retval      ETH_CHIP_STATUS_OK：设置成功
                 ETH_CHIP_STATUS_ERROR ：设置失败
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR ：不能写入寄存器
  */
int32_t eth_chip_set_link_state(eth_chip_object_t *pobj, uint32_t LinkState)
{
    uint32_t bcrvalue = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &bcrvalue) >= 0)
    {
        /* 禁用链路配置(自动协商，速度和双工) */
        bcrvalue &= ~(ETH_CHIP_BCR_AUTONEGO_EN | ETH_CHIP_BCR_SPEED_SELECT | ETH_CHIP_BCR_DUPLEX_MODE);

        if (LinkState == ETH_CHIP_STATUS_100MBITS_FULLDUPLEX)
        {
            bcrvalue |= (ETH_CHIP_BCR_SPEED_SELECT | ETH_CHIP_BCR_DUPLEX_MODE);
        }
        else if (LinkState == ETH_CHIP_STATUS_100MBITS_HALFDUPLEX)
        {
            bcrvalue |= ETH_CHIP_BCR_SPEED_SELECT;
        }
        else if (LinkState == ETH_CHIP_STATUS_10MBITS_FULLDUPLEX)
        {
            bcrvalue |= ETH_CHIP_BCR_DUPLEX_MODE;
        }
        else if (LinkState != ETH_CHIP_STATUS_10MBITS_HALFDUPLEX)
        {
            /* 错误的链路状态参数 */
            status = ETH_CHIP_STATUS_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    if(status == ETH_CHIP_STATUS_OK)
    {
        /* 写入链路状态 */
        if(pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, bcrvalue) < 0)
        {
            status = ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }

    return status;
}

/**
  * @brief       启用环回模式
  * @param       pobj: 设备对象
  * @param       pLinkState: 指向链路状态的指针
  * @retval      ETH_CHIP_STATUS_OK：设置成功
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR ：不能写入寄存器
  */
int32_t eth_chip_enable_loop_back_mode(eth_chip_object_t *pobj)
{
    uint32_t readval = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &readval) >= 0)
    {
        readval |= ETH_CHIP_BCR_LOOPBACK;

        /* 启用环回模式 */
        if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, readval) < 0)
        {
            status = ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    return status;
}

/**
  * @brief       禁用环回模式
  * @param       pobj: 设备对象
  * @param       pLinkState: 指向链路状态的指针
  * @retval      ETH_CHIP_STATUS_OK：设置成功
                 ETH_CHIP_STATUS_READ_ERROR：不能读取寄存器
                 ETH_CHIP_STATUS_WRITE_ERROR ：不能写入寄存器
  */
int32_t eth_chip_disable_loop_back_mode(eth_chip_object_t *pobj)
{
    uint32_t readval = 0;
    int32_t status = ETH_CHIP_STATUS_OK;

    if (pobj->io.readreg(pobj->devaddr, ETH_CHIP_BCR, &readval) >= 0)
    {
        readval &= ~ETH_CHIP_BCR_LOOPBACK;

        /* 禁用环回模式 */
        if (pobj->io.writereg(pobj->devaddr, ETH_CHIP_BCR, readval) < 0)
        {
            status =  ETH_CHIP_STATUS_WRITE_ERROR;
        }
    }
    else
    {
        status = ETH_CHIP_STATUS_READ_ERROR;
    }

    return status;
}
