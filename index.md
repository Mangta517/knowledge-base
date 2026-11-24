# 知识库索引

源自公开 GitHub 项目的工程档案与跨项目技术笔记。

## 项目

- [[bootloader|STM32F407 Bootloader 与串口恢复]] · 按 EEPROM 状态分流启动，将 CAN 接收的镜像暂存到 W25Q16，并保留独立 USART 恢复程序。
- [[flight|STM32F103 四轴飞控与遥控端]] · 飞控端用 FreeRTOS 组织 IMU、串级姿态控制与气压定高，遥控端用 nRF24L01P 交换输入和状态。
- [[freertos-beginer|STM32F103 FreeRTOS 学习模板]] · 公开快照保留 STM32F103C8 的 Keil 工程配置、启动文件和编译产物目录，可用于定位 RTOS 学习工程依赖。
- [[iwip|STM32F407ZGT6 以太网与触摸工程]] · 在当前提交中用 FreeRTOS 承载 lwIP、LAN8720A 网口和 Goodix 触摸任务，保留 NT35510 LCD 与外部 SRAM 支持。
- [[mspm0g3507|MSPM0G3507 电赛控制项目]] · 由 MSPM0 消费 K230 视觉坐标、在本地运行平衡 PID，并通过 Emm_V5 驱动步进机构，仓库同时保留循迹和调试模块。
- [[watch|STM32F411 智能手表]] · 将传感器采集、LVGL 显示、RTC、KT6368A 蓝牙和启动诊断组织为可追踪的双任务固件。

## 技术专题

- [[embedded-stream-framing|嵌入式串流的消息边界]] · 从 DMA、UART、CAN 和蓝牙收到的传输片段，按协议定义重组成完整消息并提交状态。
- [[ethernet-link-and-ip|从以太网链路到 IPv4 可达]] · 按 PHY 协商、MAC/DMA、netif 地址和上层协议顺序验证 MCU 以太网。
- [[sensor-feedback-pipeline|传感器反馈链路的单位与时序]] · 用采样时刻、坐标系、有效标志和控制量定义每个处理边界，使姿态、视觉和环境数据可追踪。
- [[task-and-bus-ownership|嵌入式任务与外设所有权]] · 把共享外设限定在明确的执行上下文，用快照和事件把耗时操作与消费者分开。

## 架构决策

- [[ADR-0001-stage-image-before-boot|ADR-0001 · 镜像先暂存再提交]] · F407 更新 APP 在外部 Flash 保存完整镜像，并用 EEPROM 更新标记把接收阶段与启动搬运阶段连接起来。
- [[ADR-0002-assign-sensor-bus-owner|ADR-0002 · 传感器总线交由单任务访问]] · 飞控与手表都将共享传感器总线收敛到一个任务，并为低频器件保留分频采样。
- [[ADR-0003-run-lwip-in-rtos-mode|ADR-0003 · 运行 lwIP 的 OS 模式]] · 当前 STM32F407 以太网工程由 FreeRTOS 管理网络与触摸线程，lwIP 使用 TCP/IP 核心上下文。

## 排障

- [[TS-0001-bootloader-update-phase|TS-0001 · Bootloader 收完 BIN 后未进入 APP]] · 按接收、外部 Flash 暂存、EEPROM 提交、内部搬运与向量跳转定位 F407 更新失败阶段。
- [[TS-0002-watch-startup-latency|TS-0002 · 手表首帧或正常采集延迟]] · 对照供电、首帧提交、DMA、传感器就绪、RTC/蓝牙结束及校准状态定位冷启动耗时。
- [[TS-0003-ethernet-link-without-ip|TS-0003 · 以太网插线后仍无 IP]] · 从编译时 DHCP 选项、PHY 链路和 netif 状态定位 STM32 以太网不可达的层级。
- [[TS-0004-k230-vision-timeout|TS-0004 · K230 无目标、超时与电机回执]] · 分别记录视觉有效性、UART0 新帧、目标毫度与 Emm_V5 回执，定位平衡机构无动作或回中。

## 复盘

- [[embedded-architecture-evolution|从任务模板到可验证的嵌入式架构]] · 比较六个公开仓库的运行方式、资源交接、数据有效性和故障恢复，给出跨项目读代码的顺序。
