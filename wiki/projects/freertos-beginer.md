---
title: "STM32F103 FreeRTOS 学习模板"
description: "公开快照保留 STM32F103C8 的 Keil 工程配置、启动文件和编译产物目录，可用于定位 RTOS 学习工程依赖。"
type: "project"
id: "freertos-beginer"
tags: ["stm32","freertos","cmsis-rtos2","learning"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
repo: "Mangta517/freertos-beginer"
repo_url: "https://github.com/Mangta517/freertos-beginer"
visibility: "public"
publish_policy: "public"
tier: "active"
status: "experimental"
domains: ["embedded"]
primary_language: "Makefile"
stars: 0
synced_commit: "88e3c2fa9133c614d937a5e172fbd0aabd3204b8"
featured: false
tech_stack: ["Keil MDK","FreeRTOS","CMSIS-RTOS2","STM32 HAL"]
related_topics: ["task-and-bus-ownership"]
related_adrs: []
mcu: "STM32F103C8"
signal_flow: ["向量表", "Reset_Handler", "SystemInit", "ARMCC __main"]
highlights:
  - { label: "内核", value: "Cortex-M3" }
  - { label: "工程接口", value: "CMSIS-RTOS2 声明" }
  - { label: "证据范围", value: "Keil 配置与启动汇编" }
---

## 项目定位与工程组成

`01_freertos_template.uvprojx`、Cortex-M3 启动汇编、RTE 头文件与旧构建产物组成公开快照。它可以用来审计 Keil 如何组织一个 CMSIS-RTOS2 目标，运行任务的业务定义需要从对应版本的工程源目录补齐。

> [!NOTE] 工程清单的审计基线
> 对 `88e3c2fa9133c614d937a5e172fbd0aabd3204b8` 的 [Keil XML](https://github.com/Mangta517/freertos-beginer/blob/88e3c2fa9133c614d937a5e172fbd0aabd3204b8/01_freertos_template.uvprojx) 解析全部分组，并按该文件所在目录检查依赖文件是否存在。产物中的文件名只作为历史线索。

## 硬件资源与外设映射

| 项目字段 | 快照中可证实的范围 |
| --- | --- |
| 设备 | STM32F103C8，Cortex-M3；设备宏 `STM32F103xB` |
| HAL 选择 | `USE_HAL_DRIVER`；工程引用 STM32F1xx HAL 及 CMSIS |
| 外设线索 | `adc.c`、`gpio.c`、`i2c.c`、`spi.c`、`tim.c`、`usart.c`、`usb.c` 被列为源文件 |
| 板级功能线索 | DshanMCU-F103 分组声明 OLED、MPU6050、LCD、蜂鸣器、按键等 |
| 引脚与时钟 | 需取得实际 `Core` 和 BSP 定义后，从初始化配置读取 |

`RTE/_01_freertos_template/RTE_Components.h` 将 `CMSIS_device_header` 指向 `stm32f10x.h`。该 RTE 头与 HAL 设备宏分别来自不同层的配置。异机补工程时同时核查器件包和 ST CMSIS 头的选择。[`RTE_Components.h`](https://github.com/Mangta517/freertos-beginer/blob/88e3c2fa9133c614d937a5e172fbd0aabd3204b8/RTE/_01_freertos_template/RTE_Components.h)

## 架构与执行机制

| 配置项 | 固定工程声明 |
| --- | --- |
| Keil target | `01_freertos_template`，工具集 `ARM-ADS` |
| 编译器 | `uAC6=0`，`ARMCC 5.06 update 5 build 528` |
| 预处理宏 | `USE_HAL_DRIVER,STM32F103xB` |
| 应用头 | `../Core/Inc` |
| HAL/CMSIS 头 | `../Drivers/STM32F1xx_HAL_Driver/Inc`、其 `Legacy` 子目录、`../Drivers/CMSIS/Include`、`../Drivers/CMSIS/Device/ST/STM32F1xx/Include` |
| RTOS 头 | `../Middlewares/Third_Party/FreeRTOS/Source/` 下的 `include`、`CMSIS_RTOS_V2`、`portable/RVDS/ARM_CM3` |
| 板级与应用资源 | `../Drivers/DshanMCU-F103`、`../nwatch` |

```mermaid
flowchart LR
    V["向量表提供初始 MSP 与 Reset_Handler"] --> S["SystemInit"]
    S --> C["ARMCC __main 与 C 运行时"]
    C --> M["应用 main 依赖上一级 Core"]
    M --> R["RTOS 配置由缺失的应用与移植源码决定"]
```

## 关键协议、存储布局与算法设计

### 启动汇编的可见行为

| 汇编定义或入口 | 值与职责 |
| --- | --- |
| `Stack_Size` | `0x400`，启动文件保留 1024 B |
| `Heap_Size` | `0x200`，启动文件保留 512 B C 运行时堆 |
| 向量字 0 / 1 | `__initial_sp` / `Reset_Handler` |
| 系统异常 | 向量包含 `SVC_Handler`、`PendSV_Handler`、`SysTick_Handler` |
| `Reset_Handler` | `BLX` 调 `SystemInit`，随后 `BX` 转 `__main` |
| C 库内存接口 | 按汇编条件汇出 MicroLIB 所需符号或 `__user_initial_stackheap` |

C 运行时保留区与 FreeRTOS `heap_4` 的分配区域由不同定义决定。工程声明 `heap_4.c`，实际 RTOS 堆大小、任务栈余量及 tick 和中断配置都需要 `FreeRTOSConfig.h` 与应用源码。[`startup_stm32f103xb.s`](https://github.com/Mangta517/freertos-beginer/blob/88e3c2fa9133c614d937a5e172fbd0aabd3204b8/startup_stm32f103xb.s)

## 源码入口与核心调用链

| Keil File Group | 条目 | 公开树审计 |
| --- | --- | --- |
| `Application/MDK-ARM` | 1 项，`startup_stm32f103xb.s` | 仓库已包含 |
| `Application/User/Core` | 13 项，包括 `main.c`、`freertos.c`、`music.c`、外设初始化和 HAL 时基 | `../Core/Src` 引用均缺失 |
| `Drivers/STM32F1xx_HAL_Driver` | 21 项，GPIO、UART、USB、DMA、Flash、时钟等 | `../Drivers/STM32F1xx_HAL_Driver/Src` 引用均缺失 |
| `Drivers/CMSIS` | 1 项，`system_stm32f1xx.c` | `../Core/Src` 引用缺失 |
| `Middlewares/FreeRTOS` | 10 项，7 个内核源文件及 `cmsis_os2.c`、`heap_4.c`、ARM_CM3 `port.c` | `../Middlewares/Third_Party/FreeRTOS/Source` 引用均缺失 |
| `Drivers/DshanMCU-F103` | 21 项，板载和外接器件驱动 | `../Drivers/DshanMCU-F103` 引用均缺失 |
| `nwatch` | 6 项，`draw.c`、`game1.c`、`game2.c`、`resources.c`、`beep.c/.h` | `../nwatch` 引用均缺失 |
| `::CMSIS` | Keil 组件分组，无 `FilePath` | RTE 头随仓，组件依设备包解析 |

存有同名 `.o`、`.d` 或 AXF 的子目录是构建输出。反查 `.uvprojx` 可以确认期望的源路径和组别，补工程时应核对文件实际内容和版本。

## 构建方式与验证边界

> [!TIP] 历史构建产物
> [`README.md`](https://github.com/Mangta517/freertos-beginer/blob/88e3c2fa9133c614d937a5e172fbd0aabd3204b8/README.md) 是模板式简介，公开树还保留旧 AXF、HEX、map 和链接散布文件。文件存在可确认曾保存构建产物，复现仍需对应源树。

1. 按工程根目录层级恢复 `Core/Inc` 与 `Core/Src`，包含应用入口、FreeRTOS 配置、异常桥接和厂商初始化。
2. 恢复匹配版本的 STM32F1 HAL、CMSIS、FreeRTOS、CMSIS-RTOS2、RVDS Cortex-M3 port 与 `heap_4`。
3. 补齐 DshanMCU-F103 板级驱动及 `nwatch` 代码和资源，保持 Keil 文件分组中的相对路径或相应调整工程组织。
4. 在安装所需器件包及 AC5 的环境打开目标并全量重建，核对 map 的 Flash/RAM 布局、`SystemInit` 和异常处理符号的提供者。
5. 进调度器前后记录系统时钟、栈和第一次任务切换，逐一确认 `SysTick`、`PendSV`、`SVC` 对应最终链接符号。

> [!WARNING] 完整构建与实板验证
> 快照允许审计工程声明与启动汇编。任务数、优先级、周期、内存余量及板级功能要等完整源树和重新构建后核对。

## 相关知识

| 对照项目 | 可沿公开源码继续确认 |
| --- | --- |
| [[flight|飞控与遥控端]] | `application_freertos_task.c/.h` 的原生 FreeRTOS 任务创建、栈及周期 |
| [[watch|F411 手表]] | `app_task.c` 里的 LVGL、采样任务创建、DMA 与应用层交接 |
| [[task-and-bus-ownership|任务与外设所有权]] | 从配置声明进到调用链时，应如何核对执行上下文 |

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
