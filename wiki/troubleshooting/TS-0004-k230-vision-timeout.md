---
title: "TS-0004 · K230 无目标、超时与电机回执"
description: "分别记录视觉有效性、UART0 新帧、目标毫度与 Emm_V5 回执，定位平衡机构无动作或回中。"
type: "troubleshooting"
id: "TS-0004-k230-vision-timeout"
tags: ["mspm0","k230","uart","motor"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
ts_id: "TS-0004"
severity: "medium"
related_projects: ["mspm0g3507"]
phases: ["系统武装", "UART0 新帧", "目标有效性与超时", "位置命令", "串口回执"]
---

## 典型现象与触发条件

摆杆保持、回中或停机，K230 却仍有画面。画面、串口收发、控制有效和电机实际到位分别观察。[[mspm0g3507|MSPM0G3507 平衡工程]] 默认启动后武装，排障要同时记录按键时序、视觉数据、控制目标与 Emm_V5 回执。

| 状态 | 输入例子 | 初步验证 |
| --- | --- | --- |
| 有目标 | `$410,260#` | `fresh=1, valid=1`，产生新控制量 |
| 持续无球 | `$-1,-1#` 连发 | `fresh=1, valid=0`；最近接收时刻继续刷新 |
| UART0 断流 | 停发送达到 150 ms，或只有坏帧 | 无合格新帧，超时设置无效零目标 |
| PA13 停止 | PA13 从高到低 | `g_system_armed=false`，进入一次性停止 |
| 驱动故障 | Emm 回 `E2` 或 `EE` | 锁存故障并发送停止，需明确重新武装 |

## 故障定位决策树

```mermaid
flowchart TD
    A{"g_system_armed 已置真"}
    A -->|否| P["确认 PA13 停止，观察一次 FE"]
    A -->|是| F{"持续收到可解析的新帧"}
    F -->|否| T["记录到最后合法帧的年龄和 TO"]
    F -->|是| V{"本帧 valid 为真"}
    V -->|否| L["记录无球计数、短预测及第八帧回中"]
    V -->|是| C["观察 cx 与目标毫度及限幅"]
    T --> R["达到 150 ms 后确认无效零目标"]
    C --> U{"UART1 发出了位置命令"}
    R --> U
    L --> U
    U -->|否| S["查看跟踪锁存、节流、死区和目标位置"]
    U -->|是| E["解码接受、到位、错误和位置回执"]
```

## 分层排查速查表

| 阶段 | 观测点与日志 | 正常基线 | 异常根因 | 处理 |
| --- | --- | --- | --- | --- |
| 视觉算法 | K230 画面、ROI、最终 UART 文本 | 有球发 `$cx,cy#`；移出 ROI 发 `$-1,-1#` | 光照、ROI、检测框中心出界 | 先看脚本实际发帧和图像坐标 |
| UART0 | PA10 TX/PA11 RX，115200 bit/s | 合法帧经 ISR 入环，主循环解析 | 接线、共地、位速率、FIFO/环溢出 | 以十六进制捕获起止符与间隔 |
| 组帧 | `g_uart0_data.fresh/valid`、解析错误和溢出计数 | x=0–799、y=0–479，或同时 -1 | 坏字段、中间重置、超长 | 重放一帧确定发布是否发生 |
| 无球 | `K230:(-1,-1) ok=0`、`s_ball_miss_cnt` | 合法帧刷新时间，第 8 帧清 PID/历史并设零目标 | 只观察 `valid` 就误判为断线 | 将帧龄和丢球计数同时记录 |
| 断流 | `SM[ARM] ... TO`、`g_k230_last_rx_ms` | 到 `>=150 ms` 设置无效零目标，下一新帧清超时 | 线断、K230 停帧、持续解析失败 | 验证同一帧龄时钟与坏帧计数 |
| 按键 | PA12、PA13 下降沿，`SM[ARM]` / `SM[OFF]` | PA13 解除武装并发一次 `FE`，PA12 重武装 | 停止后尚未重新武装、按键异常 | 看引脚电平和实际一帧停机命令 |
| PID 与执行接口 | `ang: tgt=`、`stp: tgt=` | 先毫度再计算脉冲，分别限幅和节流 | 中心/方向错、命令值小于死区、未发新位置 | 记录输入、PID 输出、目标与绝对位置帧 |
| 串口电机 | UART1 PA8 TX/PA9 RX，`rx=` | `FD` 位置帧；`02` 表示接受、`9F` 到位、`E2/EE` 故障 | 接错 UART2、固件协议错、到位应答未启用 | 抓原始帧并核对 Emm/X 固件和配置 |
| 零位 | `boot=` 和 `0x36` 位置应答 | 回读已有实际角度；无回复显示 `NO`，零点校验失败有 `?` | 电机未回包或装配零点偏离 | 对照绝对坐标和机械参考，按基准位置复测 |

调试打印每 200 ms 才服务一次，单条日志可能跨过 150 ms 判断边沿。用串口采样时刻与板端 `tick_ms` 对齐。`stp: cur` 来自已命令位置，实测角度需要单独的位置回包或仪器。

## 关键源码测点

| 路径 | 测点 |
| --- | --- |
| [视觉脚本](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/k230_ball_balance.py) | 实际 `uart.write` 前的坐标或无球帧 |
| [UART0 IRQ](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/interface/bsp_k230_uart.c)、[组帧](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/interface/bsp_uart0_proto.c) | FIFO→环→解析发布，`uart0_parse_frame` |
| [主循环](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/mian.c) | `g_system_armed`，`s_ball_miss_cnt`，`g_k230_timeout`，`StepperTrack_SetTarget` |
| [角度跟踪](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/application/app_stepper_track.c) | `StepperTrack_Update`、`fault`、`target_angle_mdeg`、位置发出点 |
| [驱动协议](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/interface/emmv5.c) | `EMMV5_RX_Poll`、`0x36` 定长接收、`0x6B` 帧尾 |

## 验证闭环与边界

1. 用受限台架发送有效坐标，确认 x 方向、目标角度、发出命令与机械回执。
2. 保持 UART 连通，连续发送无球帧，记录年龄刷新、预测窗口与第 8 帧进入回中。
3. 停止发送，从最后一条合格消息起测 150 ms 触发及当前命令，重新送合法帧后观察恢复。
4. 按 PA13，确认发生一次真实停止帧。重武装后单独验证正常位置发包。
5. 记录停止或丢球前后的实际角度与最后一条目标角，确认回中轨迹与急停动作的区别。
6. 检查实际驱动器返回码、到位回执设置及机械零点。用位置读取应答区分已发送目标与实际到位。

> [!WARNING]
> 需实板/仪器验证边界。-1 坐标属于协议认可的无球状态，串口超时设置的是回中目标，PA13 或驱动故障走停机。准确角度、速度、到位时间和保护行为随硬件配置实测。

同一测试使用一致的视野、机械零位和命令限幅，每轮保留首个异常帧、主循环状态和驱动回执。

相关概念见 [[embedded-stream-framing|串流组帧]]、[[sensor-feedback-pipeline|反馈量和执行器换算]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
