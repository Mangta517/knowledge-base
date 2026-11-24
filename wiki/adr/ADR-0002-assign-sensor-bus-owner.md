---
title: "ADR-0002 · 传感器总线交由单任务访问"
description: "飞控与手表都将共享传感器总线收敛到一个任务，并为低频器件保留分频采样。"
type: "adr"
id: "ADR-0002-assign-sensor-bus-owner"
tags: ["i2c","freertos","concurrency"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
adr_id: "ADR-0002"
decision_status: "accepted"
related_projects: ["flight","watch"]
---

## 背景与硬约束

[[flight|飞控]] 的 MPU6050 和 SPL006 同挂 I2C1。[[watch|手表]] 的 SENSOR 软件 I2C 挂五种器件，另有 LVGL/触摸对交互响应的要求。两者都需要在高频拍内执行感知计算，并以低频事务让设备完成自己的转换节奏。

| 系统 | 高频预算 | 低频分配 | 可量化约束 |
| --- | --- | --- | --- |
| 飞控 | 飞行任务名义 2 ms，1 kHz tick | SPL006 每 3 拍，名义 6 ms | 400 kHz I2C；MPU 一次 14 B 突读；当前 HAL 读参数可等待 100 ms |
| 手表 | `sensor` 名义 10 ms、优先级 2，`lvgl` 每轮后等待 5 ms、优先级 3 | 气压 25 拍，AHT21 2 s，心率 30 ms，电池 1 s | SENSOR 软件 I2C 按 GPIO 延时循环；EEPROM 独立总线，单次页就绪等待预算 10 ms |

飞控一次寄存器地址加 14 B burst 至少 17 个带 ACK/NACK 的字节时间，400 kHz 约 0.38 ms，另有起止条件及软件开销。气压与温度各有一次状态读和一次 3 B 取数，就绪同拍约再消耗 0.45 ms 线速。两者加起来约 0.83 ms 线速，其余预算要容纳计算、CPU 抢占与驱动开销。100 ms 为源码传入的超时量级，故障周期可能越过多个 2 ms 拍。

手表的软件总线实际频率由 GPIO 操作和延时循环共同决定。把最重一拍的事务数乘实测字节时间，再加入调度、融合、诊断和 EEPROM 同期耗时，才能确认是否满足 10 ms。气压低频分频只改变启动频率，同拍时仍吃掉一次完整事务。

## 决策与落地机制

采用单任务独占共享总线，低频操作在任务内计数或按时戳触发。飞控将气压读取和 IMU 读取顺序放在飞行任务中。手表在 `sensor` 任务里初始化 SENSOR 总线，驱动、采集、校准和快照交接均沿可追踪的调用路径。

| 执行边界 | 飞控 | 手表 |
| --- | --- | --- |
| 数据生产 | 飞行任务消费两个 I2C 器件 | `sensor` 推进各服务 |
| ISR | 高层不会在 ISR 中读 I2C | MPU EXTI 置标志，GPIO 方向切换保留短保护 |
| 数据交接 | 控制计算直接使用传感器状态 | 应用模块短锁发布快照，UI 读取 |
| 非共享总线 | 无需在两个采集任务间仲裁 | 触摸和 EEPROM 各用独立软件 I2C 引脚 |

`vTaskDelayUntil` 定义计划拍点。器件超时、校准和高优先级负载仍能推迟实际循环。配置变更时先量实际总线占用，再观察快照锁持有时长与消费者的数据年龄。

## 备选方案对比

| 方案 | 对周期与状态的影响 | 代价 | 决策 |
| --- | --- | --- | --- |
| 一个拥有者任务与分频 | 所有读写顺序和可抢占点集中；低频事务同拍需纳入预算 | 长阻塞影响本任务所有设备 | 采纳 |
| 每器件任务与 I2C mutex | 高低频设备独立唤醒，mutex 对共享句柄串行化 | 锁等待、优先级反转分析和跨任务恢复增加 | 当前事务相对短且流程集中，暂缓 |
| 纯 DMA/中断异步队列 | 可拆分 I/O 等待和算法执行；硬件 I2C 需要合适 DMA 支持 | 生命周期、取消、优先队列与错误恢复更多，软件 I2C 需重新考虑驱动 | 容限不足且测量定位到阻塞 I/O 时评估 |

## 收益、代价与失效边界

- 通过一条调用链核对互斥、限频和实际轮询间隔。设备错误可以按器件记录。
- 总线阻塞会拖累同一任务内的其他器件。飞控任务的连接校零与故障 I2C 事务尤其可能覆盖多个名义周期。手表跨拍等待蓝牙和 RTC，传感器 EEPROM 页就绪等待另计。
- 名义负荷的初始预算公式为 `剩余时间 = 周期 - 本轮事务最坏耗时 - 计算 - 高优先级抢占`。在压力和故障测试中，记录每个设备的最大读时长、任务晚点和测量有效年龄。
- 如果测得按期采样持续失败且慢事务占主导，先核对驱动超时与转换触发分阶段的收益。仍超预算时，对有硬件支持的总线评估异步队列和明确的失效期限。手表软件 I2C 的时序和 GPIO 资源要随方案验证。

### 决策复核时需要的计数与时序

| 测试负载 | 需一起记录的量 | 如何定位 |
| --- | --- | --- |
| 飞控慢设备与控制同拍 | SCL 占用、飞行任务入出和射频抢占 | 区分总线事务时长与 CPU 运行时间 |
| 手表心率和触摸同开 | SENSOR 需要的总线时间、LVGL 刷新时间、样本年龄 | 区分采集走慢与画面滞后 |
| 触发 EEPROM 页就绪等待 | 写入完成、任务让出和下一次 sensor 启动 | 检查独立总线上的同步等待对采样业务的影响 |
| 外设异常 | 返回码、最长阻塞、恢复后的第一个有效样本 | 根据失效预算决定采用分步服务或更换调度方式 |

分频按名义 2 ms 或 10 ms 推算的批次需与实际过期率比较。以需求里的最迟交付时刻作为采样可接受的上界。

## 源码证据

- [飞行任务与分频](https://github.com/Mangta517/flight/blob/8b05c39baa1731cf4873d2caaa0db34a61b63e2c/flight_hal/MDK-ARM/application/application_freertos_task.c)、[400 kHz 配置](https://github.com/Mangta517/flight/blob/8b05c39baa1731cf4873d2caaa0db34a61b63e2c/flight_hal/Core/Src/i2c.c)、[MPU 读时限](https://github.com/Mangta517/flight/blob/8b05c39baa1731cf4873d2caaa0db34a61b63e2c/flight_hal/MDK-ARM/interface/my_mpu6050.c)、[气压读时限](https://github.com/Mangta517/flight/blob/8b05c39baa1731cf4873d2caaa0db34a61b63e2c/flight_hal/MDK-ARM/interface/spl006.c)。
- [手表任务体](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_task.c)、[软件总线时序](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/common/my_i2c.c)、[EEPROM ACK 等待](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/interface/bl24c02.c)、[快照互斥](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_imu.c)。
- 实板测量、抢占场景与数据交接见 [[task-and-bus-ownership|任务与总线所有权]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
