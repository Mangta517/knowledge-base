---
title: "TS-0002 · 手表首帧或正常采集延迟"
description: "对照供电、首帧提交、DMA、传感器就绪、RTC/蓝牙结束及校准状态定位冷启动耗时。"
type: "troubleshooting"
id: "TS-0002-watch-startup-latency"
tags: ["watch","startup","lvgl","diagnostics"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
ts_id: "TS-0002"
severity: "medium"
related_projects: ["watch"]
phases: ["供电锁存", "首帧提交", "DMA 完成与可见刷新", "采样就绪", "后台模块与校准"]
---

## 典型现象与触发条件

[[watch|F411 手表]] 上电时背光亮但画面延后，画面正常却无传感数据，或初次启动时蓝牙/RTC 比采样晚完成。另一种情况是姿态值到达但零偏尚在收敛。分别记录板端启动时钟和手机侧接收时钟，以当次固件的 WDG1 和仪表测点作为基线。

| 现场条件 | 记录项 |
| --- | --- |
| 启动方式 | 冷启动或复位，RTC 备份域是否保留 |
| 电源 | PA3 自保持的上升沿和供电稳定时间 |
| 屏幕 | 背光、首次 SPI 总线活动、DMA flush 完成及可见画面 |
| 传感器 | EEPROM 是否有有效校准，手表是否保持静止 |
| 蓝牙 | 配置是否已匹配，手机何时建立 SPP、CSV 是否丢帧 |

## 故障定位决策树

```mermaid
flowchart TD
    A{"PA3 和供电稳定"}
    A -->|否| P["测电源锁存、复位与板电源"]
    A -->|是| B{"FIRST_FRAME_MS 已记录"}
    B -->|否| UI["追 LVGL 创建、屏初始化和刷新"]
    B -->|是| C{"SPI DMA 完成且画面可见"}
    C -->|否| D["用示波器及 LCD 回调定位屏路径"]
    C -->|是| S{"sensor 已置 ready 且有成功采样"}
    S -->|否| I["核对 SENSOR 总线和各器件诊断"]
    S -->|是| G{"RTC 或蓝牙有超时"}
    G -->|是| T["看 LSE 和 AT 分段时间、结果"]
    G -->|否| E["核对 MPU 校准、EEPROM 与诊断导出"]
```

## 分层排查速查表

| 阶段 | 观测点与日志 | 正常基线 | 异常根因 | 处理 |
| --- | --- | --- | --- | --- |
| 供电 | PA3、VDD、复位 | PA3 在板级初始化前拉高 | 自保持接线、电压下跌 | 共时钟量 PA3、VDD、NRST |
| 创建 LVGL | `App_Task_Create`、`App_Display_Init` | 优先级 3、1024 字栈，正常进入任务 | 分配失败、板级初始化阻塞 | 看错误入口、堆和控制流 |
| 首帧提交 | `FIRST_FRAME_MS` | `lv_refr_now` 返回后记录 | 屏初始化、刷屏路径阻塞 | 单独量函数入出时刻 |
| 首个/末个刷新事务 | DMA2 Stream2、`HAL_SPI_TxCpltCallback` / flush 回调 | 对应传输完成；可能有多个刷屏块 | SPI、DMA 配置或无完成回调 | 同看时钟、片选、回调与可见变化 |
| 传感器任务开始、就绪 | `SENSOR_BEGIN_MS`、`SENSOR_READY_MS` | 提交后创建；初始化完成后置 ready | I2C 事务、EEPROM 读取、分配 | 按 SDA/SCL 和驱动返回定位 |
| 正常采集窗口 | `SAMPLING_BEGIN_MS` 与各 sensor 记录 | 循环开始后逐器件出现有效读数 | 未就绪、NACK、循环延迟 | 比较成功数、样本年龄和采样间隔 |
| RTC | `RTC_BEGIN_MS`、`RTC_END_MS`、`RTC_RESULT` | LSE 就绪后完成配置；等待上限 5000 ms | LSE 未起振或时钟配置失败 | 查 LSERDY、电源、晶振与负载 |
| 蓝牙 | `BT_BEGIN_MS`、`BT_END_MS`、`BT_RESULT` | 20 ms 放电、1200 ms 上电等待、500 ms 查询窗口 | 模块供电、UART、AT 未匹配 | 抓 PA8 和 USART1，核对 T4/T5 |
| 校准 | `CAL_STATE`、`CAL_FRAMES`、`CAL_STABLE_FRAMES`、`CAL_RESULT` | 有有效记录立即恢复；否则按静止/平均阶段累计 | 板子在动、I2C 失败、记录无效 | 平放重启并核对 CAL 开始/结束 |
| EEPROM 保存 | WDG1 type 5 与 `CAL_RESULT` | 成功态 `0`，校准失败 `1`，RAM 成功保存失败 `2` | WP、地址/页边界、写后读回 | 先确认写入阶段与地址，再断电复测 |

设备基线不同。MPU 周期目标 10 ms，SPL006 每 250 ms 轮询 1 Hz 器件，AHT21 约 2 s 一次，心率开启后软件最低读间隔 30 ms。`SAMPLING_BEGIN_MS` 表示进入服务循环，首包应从各项的成功计数与首样本时间证据确认。

## 关键源码测点

| 路径 | 测点 |
| --- | --- |
| [启动入口](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/Core/Src/main.c) | `POWER_EN`、创建任务前各 `MX_*_Init` |
| [任务启动](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_task.c) | `lv_refr_now` 后登记 `FIRST_FRAME_MS`；紧接 `xTaskCreate(sensor)` |
| [LCD SPI](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/interface/lcd.c) | `LCD_Color_Fill_DMA`、`HAL_SPI_TxCpltCallback`、flush 完成回调 |
| [字段定义](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_diag.h)、[打包服务](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_diag.c) | 启动 16 槽，发送 `WDG1`，字段和序号小端 |
| [RTC 服务](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/interface/watch_rtc.c)、[AT 推进](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/interface/kt6368a.c) | LSE 与 AT 等待、完成状态 |
| [EEPROM 记录](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_imu_store.c)、[保存细分状态](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/docs/imu-eeprom.md) | 双副本恢复、量程、CRC、保存读回 |

启动字段的时间戳都是板端 HAL 毫秒。差值如 `BT_END_MS - BT_BEGIN_MS` 采用 32 位无符号计算，先排除 `0xFFFFFFFF` 未置值。RTC 和蓝牙结果按 HAL 返回值判断，MPU 状态和结果按应用枚举。若需区分零偏恢复是否已完成，结合 `CAL_STATE` 和 type 5 保存阶段，避免把未执行保存解释为失败。

## 验证闭环与边界

1. 在静止且固定接线条件下重复冷启动，保留同一 SHA、首次通电和后续上电的区别。
2. 以示波器或逻辑分析仪记录 VDD、PA3、LCD SPI。标记 LVGL 开始、首帧提交、各 DMA 完成和首张画面的可见时刻。
3. 从 SPP 导出启动、任务、传感器、MPU EEPROM 和校准诊断，对同一次板端时间轴做差。
4. 分别以已有有效 EEPROM 与需要校准的状态复测；临时遮断蓝牙或 RTC 时观察传感器是否继续采集。
5. 连接手机后确认帧序号及 CRC。采样成功、UART 发送成功和手机接收分别观察。

> [!WARNING]
> 需实板/仪器验证边界。没有 DMA、可见首帧或所有器件首有效样本的内置启动字段，可加仪器触发或临时测点。实际缩短量以同一硬件多次冷启动的分布为准。

[旧启动流程与测量口径](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/docs/startup-optimization.md)、[当前诊断协议及 CSV](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/docs/diagnostics.md)及 [[sensor-feedback-pipeline|传感反馈链与校准状态]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
