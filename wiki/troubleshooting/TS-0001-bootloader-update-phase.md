---
title: "TS-0001 · Bootloader 收完 BIN 后未进入 APP"
description: "按接收、外部 Flash 暂存、EEPROM 提交、内部搬运与向量跳转定位 F407 更新失败阶段。"
type: "troubleshooting"
id: "TS-0001-bootloader-update-phase"
tags: ["bootloader","eeprom","can"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
ts_id: "TS-0001"
severity: "high"
related_projects: ["bootloader"]
phases: ["接收与 CRC", "外部 Flash 暂存", "EEPROM 提交", "片内 Flash 搬运", "向量跳转"]
---

## 典型现象与触发条件

CAN 已触发更新但复位后仍运行旧 APP，主引导启动后直接进入恢复，或者串口恢复打印长度后仍无法跳转。先确认正在运行的 Keil 目标。USART 的 `cmd` 属于 LED APP；`start:len` 属于 F407 恢复程序或单独启用的 F103 装载流程。

| 复现记录 | 应记录的内容 |
| --- | --- |
| 当前镜像 | 对应 F407 目标、APP 链接基址、原始 BIN 字节数 |
| 触发与电源 | `cmd`、KEY1、`start:实际字节数` 或上电复位 |
| 传输 | CAN ID/DLC、最后有效帧与 CRC 时间；USART 命令和原始数据长度 |
| 持久化 | W25Q16 的 8 B 元数据和正文首 8 B，EEPROM 的三字节状态 |
| 结果 | 最后一条板端日志、实际复位后的运行目标 |

## 故障定位决策树

```mermaid
flowchart TD
    S{"运行在 LED APP、主引导还是恢复"}
    S -->|LED APP| CAN["发送 cmd 后捕获 hyf 与 ID 1"]
    CAN --> C{"有 CAN receive done,len: 吗"}
    C -->|否| B["检查 CAN 接线、ID、DLC 与接收窗口"]
    C -->|是| V{"CRC OK 及保存成功"}
    V -->|否| F["检查 CRC 时序、外部写入和 EEPROM 读回"]
    V -->|是| E["复位后确认 01 5A 6B 进入搬运"]
    S -->|主引导| E
    E --> W{"外部元数据与向量合法"}
    W -->|否| M["记录拒绝字段和恢复落点"]
    W -->|是| A["测擦写和片内 APP 向量"]
    S -->|USART 恢复| R["发送 start:字节数并等擦除与 DMA 就绪"]
    R --> X{"出现 ok,len: 吗"}
    X -->|否| U["看 DMA 消费量、尾部和两秒窗口"]
    X -->|是| J["检查内部向量、VTOR 和复位入口"]
    A --> J
```

## 分层排查速查表

| 阶段 | 观测点与日志关键字 | 正常基线 | 异常根因 | 修复与复测 |
| --- | --- | --- | --- | --- |
| CAN 触发 | USART1 `cmd`；总线上 `hyf` | 标准 ID 0 / DLC 3 | 命令错工程、接收未置空闲态 | 识别当前工程，重新上电从空闲开始 |
| CAN BIN | `CAN receive done,len:` | ID 1、DLC 1–8，实际 BIN 计数；最后有效帧后 1000 ms 打印 | 位速率/TX RX 错、超 5120 B、无有效帧 | 双方 200 kbit/s，验证终端、ACK 和最后两帧 |
| CRC | `CRC OK` 或 `CRC FAIL` | 末帧后 1100 ms 发 ID 1/DLC 4 小端 CRC；最后数据后 2000 ms 超时 | 提前混进 BIN、超时、尾字补法不同 | 核对捕获时间和实际长度，再用主机脚本算 CRC |
| 暂存正文 | `Update save OK` 或 `Update save FAIL` | 2049–5120 B，先正文再元数据并最后提交 | SPI 写使能、BUSY、页边界、记录读回失败 | 测第一处失败，读 W25Q16 与 EEPROM 实值 |
| EEPROM | `0x10–0x12` 实际三字节 | `01 5A 6B` 更新，成功后 `02 5A 6B`，`03 5A 6B` 恢复 | WP、电源或密钥无效 | 核对每字节，记录两次启动 |
| 外部预检 | `APP metadata error`、`APP stack pointer error`、`APP reset handler error` | 起点 `0x1000 <= start < 0x200000`，长度 `0x800 < len <= 0x78000`，不越出 W25Q16 | 地址颠倒、长度字节序错、BIN 向量错误 | 分别解码两个 LE32，核对首 8 B 与链接地址 |
| 片内擦写 | `APP update error; enter recovery` 或 `APP update ok: length=` | 从扇区 2 擦到 BIN 最后一个字节所在扇区；512 B 分批写半字 | 供电、HAL 擦写失败、外部读超时 | 记失败偏移、擦写返回值和引导落点 |
| 恢复命令 | `start:len`；`Flash erased; send data` | 长度 1–491520 B，擦除成功且 DMA 已启动 | 长度语法错误、擦除或启动失败 | 先发命令，等日志后再发二进制 |
| 恢复收尾 | `ok,len:` 或 `RX error; reset` | 长度和接收实际一致，空闲确认后等 2 s | 早发、少发、多发、环处理不及时 | 捕获全部源数据，记录最后字节与 DMA 下标 |
| 最终跳转 | `Error: Invalid stack pointer in application!`、`Error: Invalid reset handler in application!` 或 `jump error` | MSP 8 B 对齐，Thumb 复位入口在目标分区 | BIN 用错链接地址、向量已损坏 | 比对 map、片内首 8 B、VTOR 和程序实际落点 |

EEPROM 密钥无效时，主引导写 `01 5A 6B`，本次仍用原 RAM 状态。下次状态读回有效后才走升级。串口恢复打印 `ok,len:` 说明接收收尾成功，随后仍要执行独立向量校验。

## 关键源码测点

| 路径 | 函数或变量 | 捕获内容 |
| --- | --- | --- |
| [CAN 接收 APP](https://github.com/Mangta517/bootloader/blob/6d5aebc586133f383908581183b44e6572b7be06/stm32f407vet6led/application/app_update.c) | `app_update_state`、`can_rx_len`、`app_update_save_image` | verify 转移、CRC 与外部提交时刻 |
| [CAN 发送端](https://github.com/Mangta517/bootloader/blob/6d5aebc586133f383908581183b44e6572b7be06/STM32F103CAN/appliaction/app_update.c) | `send_offset`、帧间和 CRC 等待 | 最后一帧数据和 CRC 的时间差 |
| [启动状态机](https://github.com/Mangta517/bootloader/blob/6d5aebc586133f383908581183b44e6572b7be06/stm32f407vet6/application/app_bootloader.c) | `bootloader_check_update_status`、`w25_app_start_addr`、`app_size_bytes` | 密钥、更新标志、外部元数据、片内擦写 |
| [向量跳转](https://github.com/Mangta517/bootloader/blob/6d5aebc586133f383908581183b44e6572b7be06/stm32f407vet6/interface/int_bootloader.c) | `app_stack_ptr`、`app_reset_handle`、`SCB->VTOR` | 目标地址与是否完成交接 |
| [恢复状态机](https://github.com/Mangta517/bootloader/blob/6d5aebc586133f383908581183b44e6572b7be06/stm32f407vet6reset/application/app_reset.c) | `boot_state`、`uart1_rx_app_len`、`uart1_rx_full_len`、`uart1_rx_complete_tick` | 声明、接收、空闲、收尾与异常复位 |

向量检查时，最终 APP 分区上界为 `0x08080000`，恢复分区上界为 `0x08008000`。初始 MSP 必须在 `(0x20000000,0x20020000]` 或 `(0x10000000,0x10010000]`。复位地址为 Thumb，且在所选入口基址加 8 字节至分区上界前。外部候选预检以上次暂存的真实镜像长度作为复位字上界。

## 验证闭环与边界

1. 正常 CAN 样本从 `cmd` 开始，关联总线捕获、暂存内容和 EEPROM 提交，最后记录复位后 APP 入口。
2. 分别模拟缺 CRC、串口短发和错向量。先确认错误归属到 verify、DMA 收尾或跳转，再用正确样本复测。
3. 台架掉电测试需分别在暂存、标记、擦除、写入和清标记边界执行。保留独立恢复镜像与有线调试手段。
4. 恢复验证先记录命令及声明长度，等 `Flash erased; send data` 后才送 BIN，最后核对 `ok,len:` 和实际 APP 入口。

> [!WARNING]
> 需实板/仪器验证边界。`CRC OK` 验证 CAN 传输，`Update save OK` 验证外部提交，`APP update ok` 指示片内写入流程结束。最终需由向量、实际启动和实验记录确认。

相关机制见 [[ADR-0001-stage-image-before-boot|镜像暂存决策]]、[[embedded-stream-framing|串流组帧]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
