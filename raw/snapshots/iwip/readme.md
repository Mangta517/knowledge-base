# STM32F407 霸天虎 V2 项目资料路径

本项目使用野火 STM32F407ZGT6 霸天虎 V2 开发板，包含裸机 lwIP、LAN8720A 以太网、LCD、触摸、SPI Flash 和外部 SRAM。

本页汇总本机资料与项目文件的位置，路径核对日期：2026-11-13。工程实现、引脚和编译说明见 [README-lwIP.md](D:/3251/stm32f407zgt6/lwip/README-lwIP.md)。

## 1. 工程入口

当前工程路径：

```text
D:\3251\stm32f407zgt6\lwip
```

`D:\3251` 是指向 `D:\32 51` 的目录联接，因此下面的路径对应同一份工程：

```text
D:\32 51\stm32f407zgt6\lwip
```

| 内容 | 本机路径 |
| --- | --- |
| Keil 工程，目标名 lwip | [MDK-ARM/lwip.uvprojx](D:/3251/stm32f407zgt6/lwip/MDK-ARM/lwip.uvprojx) |
| CubeMX 配置 | [lwip.ioc](D:/3251/stm32f407zgt6/lwip/lwip.ioc) |
| lwIP、LCD、触摸移植与使用说明 | [README-lwIP.md](D:/3251/stm32f407zgt6/lwip/README-lwIP.md) |
| 当前目录中的固件 BIN | [MDK-ARM/lwip/lwip.bin](D:/3251/stm32f407zgt6/lwip/MDK-ARM/lwip/lwip.bin) |
| 外部 SPI Flash 中文字库资源 | [Drivers/BSP/font/resources/GB2312_H3232.bin](D:/3251/stm32f407zgt6/lwip/Drivers/BSP/font/resources/GB2312_H3232.bin) |

## 2. 开发板配套资料

资料总目录：[野火 STM32F407 霸天虎 V2](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2)。

```text
D:\单片机与模块资料\01_单片机与开发板\STM32\开发板配套资料\野火STM32F407霸天虎V2
```

资料目录说明见 [00_资料说明.txt](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/00_资料说明.txt)，文件来源与校验登记见 [资料来源.csv](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/资料来源.csv)。

### 硬件资料

| 资料 | 本机路径 |
| --- | --- |
| V2 底板原理图 | [野火_F407霸天虎_原理图_V2.0.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/野火_F407霸天虎_原理图_V2.0.pdf) |
| 管脚与复用功能表 | [STM32F407ZGT6管脚汇总（含第二功能）.xlsx](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/STM32F407ZGT6管脚汇总（含第二功能）.xlsx) |
| 配套液晶模块原理图 | [4.5寸液晶模块原理图.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/4.5寸液晶模块原理图.pdf) |
| 排针与结构尺寸 | [F407_霸天虎V2_排针尺寸标注图.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/F407_霸天虎V2_排针尺寸标注图.pdf) |
| V1/V2 硬件差异 | [【野火】STM32F407霸天虎V1与V2版本的差异.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/【野火】STM32F407霸天虎V1与V2版本的差异.pdf) |
| 硬件资料总包，含封装与 IC 手册 | [野火F407霸天虎官方硬件资料包_V1与V2_含封装与IC手册.zip](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/01_硬件资料/野火F407霸天虎官方硬件资料包_V1与V2_含封装与IC手册.zip) |

硬件总包同时包含 V1 和 V2；本工程接线以 V2 原理图为准。

### 开发指南与例程

| 资料 | 本机路径 |
| --- | --- |
| 开发板必读说明 | [STM32开发板必读说明](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/02_开发指南/[野火EmbedFire]《STM32开发板必读说明》.pdf) |
| HAL 库开发教材 | [STM32 HAL库开发实战指南——基于野火霸天虎开发板](<D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/02_开发指南/[野火EmbedFire]《STM32 HAL库开发实战指南——基于野火霸天虎开发板》.pdf>) |
| 标准库开发教材 | [STM32库开发实战指南——基于野火霸天虎开发板](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/02_开发指南/[野火EmbedFire]《STM32库开发实战指南——基于野火霸天虎开发板》.pdf) |
| HAL 库例程源码 | [ebf_stm32f407_batianhu_hal_code-master.zip](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/03_例程源码/ebf_stm32f407_batianhu_hal_code-master.zip) |
| 标准库例程源码 | [ebf_stm32f407_batianhu_std_code-master.zip](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/03_例程源码/ebf_stm32f407_batianhu_std_code-master.zip) |
| 官方产品页、在线教材、GitHub 与网盘的本地快捷方式 | [04_官方入口](D:/单片机与模块资料/01_单片机与开发板/STM32/开发板配套资料/野火STM32F407霸天虎V2/04_官方入口) |

本工程使用 HAL，查找 LCD、触摸、Flash、SRAM 等配套驱动时优先参考 HAL 库例程。

## 3. MCU、内核与外设手册

| 资料 | 本机路径 |
| --- | --- |
| STM32F405/F407 数据手册，文件名标注 DS8626 Rev12 | [STM32F405_STM32F407_数据手册_DS8626_Rev12_2026_英文.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/STM32F4/STM32F405_STM32F407_数据手册_DS8626_Rev12_2026_英文.pdf) |
| STM32F4 参考手册 RM0090，英文 Rev22 | [RM0090_STM32F405_407_415_417_427_429_437_439_Rev22_英文.pdf](D:/单片机与模块资料/01_单片机与开发板/STM32/STM32F4/RM0090_STM32F405_407_415_417_427_429_437_439_Rev22_英文.pdf) |
| STM32F4 中文参考手册 | [STM32F4中文参考手册_RM0090.pdf](D:/单片机与模块资料/STM32F4中文参考手册_RM0090.pdf) |
| Cortex-M4 通用用户指南 | [ARM_DUI0553A_Cortex-M4_通用用户指南_英文.pdf](D:/单片机与模块资料/02_ARM内核/ARM_DUI0553A_Cortex-M4_通用用户指南_英文.pdf) |
| LAN8720A 以太网 PHY 手册 | [LAN8720A.pdf](D:/单片机与模块资料/03_模块与芯片/无线与通信/其他通信/LAN8720A.pdf) |
| LAN8710A/LAN8720A 中文产品简介 | [LAN8710A_LAN8720A_中文产品简介_Microchip_DS00001642A_CN.pdf](D:/单片机与模块资料/03_模块与芯片/无线与通信/其他通信/LAN8710A_LAN8720A_中文产品简介_Microchip_DS00001642A_CN.pdf) |
| W25Q128 SPI Flash 手册 | [W25Q128.pdf](D:/单片机与模块资料/03_模块与芯片/存储器/W25Q128.pdf) |
| W25Q128BV 型号手册 | [W25Q128BV.PDF](D:/单片机与模块资料/03_模块与芯片/存储器/W25Q128BV.PDF) |

## 4. lwIP 移植参考

当前工程的参考压缩包：[lwIP例程1 lwIP裸机移植.zip](<E:/BaiduNetdiskDownload/lwIP例程1 lwIP裸机移植.zip>)。

```text
E:\BaiduNetdiskDownload\lwIP例程1 lwIP裸机移植.zip
```

工程内的协议栈源码位于 [Middlewares/Iwip](D:/3251/stm32f407zgt6/lwip/Middlewares/Iwip)，板级以太网驱动位于 [Drivers/BSP/ETHERNET](D:/3251/stm32f407zgt6/lwip/Drivers/BSP/ETHERNET)。

## 5. 项目调试与验证记录

| 内容 | 本机路径 |
| --- | --- |
| lwIP 移植、PHY 测试与构建记录 | [work/lwip-port-20261112/验证记录.md](D:/3251/stm32f407zgt6/lwip/work/lwip-port-20261112/验证记录.md) |
| LCD、触摸、字体与存储移植记录 | [work/lcd-touch-port-20261112/移植验证记录.md](D:/3251/stm32f407zgt6/lwip/work/lcd-touch-port-20261112/移植验证记录.md) |
| LCD 白屏异常现场与诊断 | [work/lcd-white-screen-20261113/异常现场.md](D:/3251/stm32f407zgt6/lwip/work/lcd-white-screen-20261113/异常现场.md) |
| 触摸 XY 修正差异、主机测试和构建日志 | [work/touch-xy-fix-20261113](D:/3251/stm32f407zgt6/lwip/work/touch-xy-fix-20261113) |
| J-Link / SWD 接线参考图 | [work/jlink-wiring-20261112/J2-SWD.png](D:/3251/stm32f407zgt6/lwip/work/jlink-wiring-20261112/J2-SWD.png) |
| lwIP 移植前的原始文件备份 | [work/lwip-port-20261112/restore-original.zip](D:/3251/stm32f407zgt6/lwip/work/lwip-port-20261112/restore-original.zip) |
| LCD、触摸与存储接入前的文件备份 | [work/lcd-touch-port-20261112/before.zip](D:/3251/stm32f407zgt6/lwip/work/lcd-touch-port-20261112/before.zip) |
| 白屏问题修复前的文件备份 | [work/lcd-white-screen-20261113/before.zip](D:/3251/stm32f407zgt6/lwip/work/lcd-white-screen-20261113/before.zip) |

本页的核对范围是资料路径是否存在；各次主机测试、构建及实板验证情况以对应记录为准。
