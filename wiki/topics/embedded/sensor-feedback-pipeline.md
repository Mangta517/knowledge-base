---
title: "传感器反馈链路的单位与时序"
description: "用采样时刻、坐标系、有效标志和控制量定义每个处理边界，使姿态、视觉和环境数据可追踪。"
type: "topic"
id: "sensor-feedback-pipeline"
tags: ["sensor","imu","control","timing"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
domain: "embedded"
related_projects: ["flight","mspm0g3507","watch"]
---

## 问题本质与适用边界

反馈链的每级要明确来源、单位、坐标系和有效时刻。读出寄存器只能说明设备返回了数值。换算、校准和数据时效共同决定该样本能用于姿态估计、环境显示或执行器控制。闭环再需要确认输出符号和执行器是否真正完成动作。

飞控把姿态与气压用于主动控制，手表把传感器结果用于显示和诊断，MSPM0 将外部视觉变成位置命令。同一套观测方法可以检查这些链路，控制输出只存在于有执行器的项目。

## 核心机制模型

```mermaid
flowchart LR
    R["原始寄存器或视觉消息"] --> U["校准与单位换算"]
    U --> C["对齐坐标系和方向"]
    C --> V{"质量与新鲜度成立"}
    V -->|可用| S["计算、显示或控制"]
    V -->|无效或过期| X["按策略保留、降级或回中"]
    S --> L["执行器限幅与单位转换"]
    L --> A["PWM 或串口位置命令"]
    A --> F["实物轨迹或回执"]
``` 

时间戳宜从生产端接近采样时刻取得。轮询时刻、收到字节时间、算法推进时间和动作回执各带各的延迟。差分速度使用两个样本间隔，PID 取控制更新间隔，旧数据回退用统一时钟的年龄。三个量在日志中最好同时保留。

## 跨项目实现对比

| 项目 | 原始量和坐标 | 有效性与恢复 | 输出和观测 |
| --- | --- | --- | --- |
| [[flight|飞控]] | MPU6050 六轴与 SPL006 压力/温度，角度与 °/s 分开 | 连接边沿校零，`IDLE` 静止修正，油门和状态门控 | X 布局混控的 `TIM2` `CCR` 与实际姿态响应 |
| [[watch|手表]] | MPU6050、LSM303DLHC，后者按 X/Z/Y 读取并换成机体 μT | EEPROM 双槽、量程和 CRC；无有效磁参考时六轴递推 | UI 快照与 `WDG1` 诊断，保存失败可与当前 RAM 校准并存 |
| [[mspm0g3507|视觉平衡]] | 800×480 像素，中心 `x=400`，速度 px/ms | UART 解析、`fresh/valid`、无球与 150 ms 超时 | 摆杆 mdeg → 电机脉冲 → 到位/故障回执 |

对应 [飞控控制环](https://github.com/Mangta517/flight/blob/8b05c39baa1731cf4873d2caaa0db34a61b63e2c/flight_hal/MDK-ARM/application/application_flight.c)、[姿态生产及磁有效性](https://github.com/Mangta517/watch/blob/fbd89280178acf4a51e80f919e7f96468b4967f0/application/app_imu.c)、[视觉到角度命令](https://github.com/Mangta517/MSPM0G3507/blob/d0232ccc9a7e31693e8fa0d1f234f242cd282856/mian.c)。飞控的姿态环和定高环有各自 `dt`。当前手表磁校准只建立轴向比例与偏置，画图审计时可用磁数据椭球与航向变化判断是否还有轴间误差。

## 可复用模式与常见反模式

此骨架以单轴毫度闭环为例。ISR 或摄像头给出原始结果，发布层完成单位和方向转换，控制端只接收同一时基且带序号的样本。`control_sample_copy` 需遵循 [[task-and-bus-ownership|快照所有权]]。

```c
typedef struct
{
    uint32_t sample_ms;
    uint32_t seq;
    int32_t position_mdeg;
    uint8_t valid;
} control_sample_struct;

void control_update(uint32_t now_ms)
{
    static uint32_t last_seq;
    static uint8_t have_seq;
    control_sample_struct sample;
    int32_t target_mdeg;

    control_sample_copy(&sample);
    if (!sample.valid || (uint32_t)(now_ms - sample.sample_ms) >= MAX_SAMPLE_AGE_MS)
    {
        control_pid_reset();
        actuator_set_idle();
        have_seq = 0;
        return;
    }
    if (have_seq && sample.seq == last_seq)
    {
        return;
    }
    last_seq = sample.seq;
    have_seq = 1;

    /* 单位和方向已在样本生产处确认。 */
    target_mdeg = control_target_mdeg(&sample);
    actuator_set_mdeg(limit_target_mdeg(target_mdeg));
}
```

示例采用失效后清控制记忆并转空闲的策略。实际系统可用短时预测、转备用观测或回中，必须为该状态定义退出条件与可测的时间上限。设备状态首次有效或序号回绕时，使用当地时基和对象约定判定。

| 反模式 | 表现 | 核对方法 |
| --- | --- | --- |
| 机械正方向与传感器正方向各自定义 | 反馈放大偏差或左右互换 | 单轴小幅激励，核对输入、控制量、实际动作三者符号 |
| °、°/s、mdeg、脉冲直接混用 | 输出饱和，限幅看似早触发 | 用已知角度手工推一次所有倍率和取整 |
| 重复使用旧帧积分 | 丢帧时积累命令、恢复时跳变 | 重放重复序号，同时记录实际 `dt` |
| 只记录高层成功 | 到位异常被当成识别问题 | 区分已写 UART、驱动接受和电机反馈 |
| 把保存失败当作校准失败 | 掩盖本次校准成功或下次启动复发 | 分别记录 RAM 与 EEPROM 状态 |

## 系统化验证用例

| 用例 | 试验输入 | 观察量 | 判别要点 |
| --- | --- | --- | --- |
| 静止零偏 | 按基准装向放平并保持静止 | 原始轴值、零偏、角速度及航向漂移 | 检查静止判定、校准状态及残余漂移 |
| 单轴符号 | 依次小幅转动一个轴或移动钢珠 | 单轴方向、PID 修正号和输出通道 | 偏差受反馈压小，通道与物理方向一致 |
| 阶跃与限幅 | 重放有边界的输入阶跃 | 首拍 `dt`、峰值、限幅、到位 | 输出受命令和机械两级边界约束 |
| 遮挡与断流 | 合法无效帧 vs 停止发送 | 样本年龄、丢失计数、回中或降级 | 每条状态路径可由证据归属 |
| 写入中断 | 注入 EEPROM 读回错误或部分写入 | RAM 偏移、保存结果及重启读回 | 当前状态与持久化状态各自可解释 |
| 恢复 | 重新给稳定样本或明确重新武装 | 新帧序号、积累项、回执、恢复时间 | 按该项目状态机恢复并可复测 |

涉及电机时，用受限台架验证方向和边界。手表校准保留和启动诊断见 [[TS-0002-watch-startup-latency|启动排障]]，视觉失效路径见 [[TS-0004-k230-vision-timeout|视觉超时排障]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
