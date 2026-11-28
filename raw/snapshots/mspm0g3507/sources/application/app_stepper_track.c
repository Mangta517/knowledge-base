/**
 * @file    app_stepper_track.c
 * @brief   Emm_V5 闭环步进电机角度跟踪控制器实现
 *
 * 工作流程:
 *   1. K230通过UART0发送 "$<cx>,<cy>,<angle_mdeg>#" 给MSPM0
 *   2. bsp_uart0_proto.c 解析后存入 g_uart0_data, 设置 fresh=1
 *   3. 主循环调用 StepperTrack_SetTarget(angle_mdeg, valid)
 *   4. StepperTrack_Update(tick_ms) 角度→脉冲, 通过UART1下发Emm_V5
 *
 * 与原42步进方案的差异:
 *   原方案: MSPM0生成脉冲+梯形加减速 (StepMotor42), MSPM0知道实际位置.
 *   现方案: Emm_V5串口闭环电机, MSPM0下发绝对位置命令(rel=1, 相对上电/
 *           清零零点), 电机内部闭环+自加减速. 绝对模式自校正: 命令被丢弃
 *           或电机堵转打断时, 下一条绝对命令仍指向真实目标, 无累积漂移.
 *   反馈:  轮询解析 UART1 回复帧 — 到位(9F)精确判定运动完成, E2 识别
 *           堵转/参数错误 (需上位机将电机"控制命令应答"设为 Reached/Both).
 *
 * 平滑策略:
 *   - 目标变化 < 角度死区: 不动作 (避免抖动)
 *   - 角度死区与步进死区同量级 (≈0.1°), 避免0.9°静差带与K230积分项相互
 *     作用产生的极限环振荡 (摆杆来回猛跳)
 *   - 偏差分档: 小偏差慢速微调, 大偏差快速追赶; 速度档带滞回, 边界不来回跳档
 *
 * 安全保护:
 *   - 机械限位 (±TRACK_MAX_ANGLE_MDEG)
 *   - 无钢珠超时自动回中 (K230持续发 $-1,-1,0#)
 */

#include "app_stepper_track.h"
#include "emmv5.h"

/* Faster response bands for the balance loop. */
#undef TRACK_VEL_RPM_SETTLE
#undef TRACK_VEL_RPM_MED
#undef TRACK_VEL_RPM_FAST
#define TRACK_VEL_RPM_SETTLE 300
#define TRACK_VEL_RPM_MED    720
#define TRACK_VEL_RPM_FAST   1400
#include "clock.h"   /* tick_ms, mspm0_delay_ms */
#include <stdlib.h>

/* ========================================================================
 *  全局跟踪状态
 * ======================================================================== */

static stepper_track_t g_track;

/* ========================================================================
 *  角度 ↔ 脉冲 转换
 * ======================================================================== */

int32_t StepperTrack_AngleToSteps(int32_t angle_mdeg)
{
    /*
     * pulses = angle_mdeg * STEPS_PER_DEGREE_NUM / (STEPS_PER_DEGREE_DEN * 1000)
     *
     * 例: angle_mdeg = 5000 (5.000°)
     *   pulses = 5000 * 6400 / (360 * 1000) = 32000000 / 360000 ≈ 88.9 → 89 脉冲
     *
     * 使用64位避免溢出
     */
    int64_t num = (int64_t)angle_mdeg * STEPS_PER_DEGREE_NUM;
    int64_t den = (int64_t)STEPS_PER_DEGREE_DEN * 1000LL;
    int64_t pulses;

    if (num >= 0) {
        pulses = (num + den / 2) / den;  /* 四舍五入 */
    } else {
        pulses = (num - den / 2) / den;
    }

    /* 曲杆机构方向反转: 正角度 → 负脉冲 (CW), 负角度 → 正脉冲 (CCW).
     * 球偏右 → PID输出正角度 → 取反→负脉冲 → 板左倾 → 球往左滚回中.
     * 球偏左 → PID输出负角度 → 取反→正脉冲 → 板右倾 → 球往右滚回中. */
    return -(int32_t)pulses;
}

int32_t StepperTrack_StepsToAngle(int32_t pulses)
{
    /*
     * angle_mdeg = pulses * STEPS_PER_DEGREE_DEN * 1000 / STEPS_PER_DEGREE_NUM
     */
    int64_t num = (int64_t)pulses * STEPS_PER_DEGREE_DEN * 1000LL;
    int64_t den = (int64_t)STEPS_PER_DEGREE_NUM;
    int64_t angle;

    if (num >= 0) {
        angle = (num + den / 2) / den;
    } else {
        angle = (num - den / 2) / den;
    }

    /* 与 AngleToSteps 取反对应, 保持"命令角度 ↔ 电机位置"语义一致 */
    return -(int32_t)angle;
}

/* ========================================================================
 *  跟踪控制器实现
 * ======================================================================== */

/* 阻塞读取电机实时位置: 发命令 + 轮询 RX, 直到收到回复或超时.
 * 仅用于上电初始化 (主循环尚未运行), 之后由 StepperTrack_Update 轮询. */
static bool stepper_read_position_blocking(int32_t *pos_mdeg, uint32_t timeout_ms)
{
    EMMV5_ReadPosition(EMMV5_DEFAULT_ADDR);
    uint32_t t0 = tick_ms;
    while ((uint32_t)(tick_ms - t0) < timeout_ms) {
        EMMV5_RX_Poll();
        if (EMMV5_RX_GetPosition(pos_mdeg)) {
            return true;
        }
        mspm0_delay_ms(2);
    }
    return false;
}

void StepperTrack_Init(void)
{
    /* 使能 Emm_V5 闭环步进 + 解除可能残留的堵转保护 */
    EMMV5_Enable(EMMV5_DEFAULT_ADDR, true);
    EMMV5_ResetClog(EMMV5_DEFAULT_ADDR);

    /*
     * 0° 基准 = 本次上电的电机位置:
     *   1) 清零前读回电机实时位置 (编码器单圈绝对值, 0-360°), 记录上电瞬间
     *      机构停在哪 — 这个值就是本次上电要固化为 0° 的参考.
     *   2) ClearPosition 把"当前机械位置"固化为电机的绝对坐标零点 → 上电位置即 0°.
     *      之后 rel=1 绝对命令都以它为基准, 每条命令自校正, 无累积漂移.
     *   3) 清零后回读校验: 实时位置应回到 ≈0, 确认 0° 基准确实建立.
     */
    g_track.startup_position_valid = stepper_read_position_blocking(
        &g_track.startup_position_mdeg, 100U);

    EMMV5_ClearPosition(EMMV5_DEFAULT_ADDR);

    int32_t zero_check = 0;
    g_track.startup_zero_ok = false;
    if (stepper_read_position_blocking(&zero_check, 100U)
        && zero_check >= -TRACK_ZERO_OK_MDEG
        && zero_check <=  TRACK_ZERO_OK_MDEG) {
        g_track.startup_zero_ok = true;
    } else {
        /* 清零未生效 (回读不接近 0): 重发一次, 兜底 */
        EMMV5_ClearPosition(EMMV5_DEFAULT_ADDR);
        zero_check = 0;
        (void)stepper_read_position_blocking(&zero_check, 100U);
        g_track.startup_zero_ok = (zero_check >= -TRACK_ZERO_OK_MDEG
                                   && zero_check <= TRACK_ZERO_OK_MDEG);
    }

    g_track.target_angle_mdeg    = 0;
    g_track.current_angle_mdeg   = 0;
    g_track.target_steps         = 0;
    g_track.state                = TRACK_IDLE;
    g_track.vel_band             = 0;
    g_track.valid                = false;
    g_track.moving               = false;
    g_track.fault                = false;
    g_track.last_update_ms       = 0;
    g_track.settle_start_ms      = 0;
    g_track.position_error       = 0;
    g_track.last_sent_angle_mdeg = 0;
}

void StepperTrack_SetTarget(int32_t angle_mdeg, bool valid)
{
    /* 机械限位: 钳位到 ±TRACK_MAX_ANGLE_MDEG */
    if (angle_mdeg > TRACK_MAX_ANGLE_MDEG)
        angle_mdeg = TRACK_MAX_ANGLE_MDEG;
    else if (angle_mdeg < -TRACK_MAX_ANGLE_MDEG)
        angle_mdeg = -TRACK_MAX_ANGLE_MDEG;

    /* 无钢珠 → 目标为0 (回中) */
    if (!valid) {
        angle_mdeg = 0;
    }

    /*
     * 死区过滤: 当前电机运动中, 且K230新角度与上次"已执行"角度变化很小
     * (<0.1°) 时忽略, 避免微抖动导致电机不断微调.
     * 例外: 始终接受 valid 状态变化 (从有→无, 从无→有).
     */
    if (valid == g_track.valid) {
        int32_t delta = angle_mdeg - g_track.last_sent_angle_mdeg;
        if (abs(delta) < TRACK_ANGLE_DEAD_MDEG && g_track.moving) {
            g_track.target_angle_mdeg = angle_mdeg;
            g_track.valid = valid;
            return;
        }
    }

    g_track.target_angle_mdeg    = angle_mdeg;
    g_track.valid                = valid;
    g_track.last_sent_angle_mdeg = angle_mdeg;
    g_track.last_update_ms       = 0;  /* 由 Update 赋值 */
}

void StepperTrack_Update(uint32_t tick_ms)
{
    /* ── 0. 处理电机回复 (轮询 UART1 RX): 到位 / 故障 ── */
    bool reached, fault;
    EMMV5_RX_Poll();
    EMMV5_RX_GetFlags(&reached, &fault);

    if (fault) {
        /* E2/EE 可能表示参数错误、堵转、过热或过流。锁存故障，禁止自动
         * 解除保护；必须由用户明确重新武装，避免反复清除硬件保护。 */
        g_track.fault = true;
        g_track.valid = false;
        g_track.moving = false;
        g_track.state = TRACK_IDLE;
        g_track.target_angle_mdeg = 0;
        g_track.position_error = 0;
        EMMV5_Stop(EMMV5_DEFAULT_ADDR);
        return;
    }

    if (g_track.fault) {
        return;
    }

    if (reached) {
        /* 上一条位置命令已到位: 精确判定运动完成.
         * (需上位机将电机"控制命令应答"设为 Reached/Both 才有 9F 回复;
         *  否则仍走下方 TRACK_IDLE_MS 超时判定) */
        g_track.moving = false;
        g_track.state  = TRACK_IDLE;
    }

    /* ── 1. 目标角度 → 目标绝对脉冲位置 ── */
    int32_t target_steps = StepperTrack_AngleToSteps(g_track.target_angle_mdeg);

    /* ── 1b. 电机轴脉冲级硬限幅: 从上电零点起, 电机轴不超过 ±TRACK_MAX_PULSES
     * (±22.5°), 保证机械行程 ±25° 内. 无论角度换算误差多大都兜底. ── */
    if (target_steps >  TRACK_MAX_PULSES) target_steps =  TRACK_MAX_PULSES;
    if (target_steps < -TRACK_MAX_PULSES) target_steps = -TRACK_MAX_PULSES;

    /* ── 2. 偏差 = 新目标 - 已命令的目标 (rel=1 绝对坐标基准) ── */
    int32_t delta = target_steps - g_track.target_steps;

    /* ── 2b. 命令节流: 距上次下发不足 TRACK_CMD_MIN_INTERVAL_MS → 跳过本次.
     * 例外: 大偏差(>中偏差阈值)不受节流限制, 保证快速响应. ── */
    if (g_track.moving
        && abs(delta) <= TRACK_MED_DELTA_STEPS
        && (uint32_t)(tick_ms - g_track.last_update_ms) < TRACK_CMD_MIN_INTERVAL_MS) {
        g_track.position_error = delta;
        return;
    }

    /* ── 3. 死区检查: 偏差在死区内 → 不动作 ── */
    if (abs(delta) <= TRACK_DEAD_ZONE_STEPS) {
        /* 自上次下发后经过 TRACK_IDLE_MS 仍未再动 → 认为运动完成 */
        if (g_track.moving
            && (uint32_t)(tick_ms - g_track.last_update_ms) >= TRACK_IDLE_MS) {
            g_track.moving = false;
            g_track.state  = TRACK_IDLE;
        }
        g_track.position_error = delta;
        return;
    }

    /* ── 4. 需要移动 → 按偏差大小分档选速度(RPM)和加速度 ── */
    uint32_t abs_delta = (uint32_t)((delta >= 0) ? delta : -delta);
    uint16_t vel;               /* RPM, 0-5000 需 uint16_t */
    uint8_t  acc;
    uint8_t  band;              /* 0=SETTLE, 1=MED, 2=FAST */

    /* 滞回分档: 升档用大阈值, 降档用小阈值, 避免偏差在档位边界抖动时
     * 电机速度在 60↔150↔300 RPM 之间来回切换造成顿挫 */
    switch (g_track.vel_band) {
    case 0:  /* 当前SETTLE: 偏差明显变大才升档 */
        band = (abs_delta > TRACK_MED_DELTA_STEPS)   ? 2U :
               (abs_delta > TRACK_SMALL_DELTA_STEPS) ? 1U : 0U;
        break;
    case 1:  /* 当前MED: 回落<160才降档, 上升>1600才升档 */
        band = (abs_delta > TRACK_MED_DELTA_STEPS)   ? 2U :
               (abs_delta <= TRACK_HYST_DOWN_SETTLE) ? 0U : 1U;
        break;
    default: /* 当前FAST: 需明显回落才降档 */
        band = (abs_delta <= TRACK_HYST_DOWN_SETTLE) ? 0U :
               (abs_delta <= TRACK_HYST_DOWN_MED)    ? 1U : 2U;
        break;
    }
    g_track.vel_band = band;

    if (band == 0U) {
        /* 小偏差: 低速微调, 柔顺追踪 */
        g_track.state = TRACK_SETTLING;
        vel = TRACK_VEL_RPM_SETTLE;
        acc = TRACK_ACC_SETTLE;
    } else if (band == 1U) {
        /* 中偏差: 中速 */
        g_track.state = TRACK_MOVING;
        vel = TRACK_VEL_RPM_MED;
        acc = TRACK_ACC_MED;
    } else {
        /* 大偏差: 快速追赶 (K230发大角度指令 → 摆杆快速偏转) */
        g_track.state = TRACK_MOVING;
        vel = TRACK_VEL_RPM_FAST;
        acc = TRACK_ACC_FAST;
    }

    /* ── 5. 下发绝对位置命令 (rel=1): 电机目标 = target_steps (相对绝对零点).
     * 绝对模式自校正: 即使某条命令被丢弃/电机被堵转打断, 下一条命令仍指向
     * 真实的绝对目标, 无累积漂移 (相对 rel=0 的根本改进). ── */
    EMMV5_PositionSigned(EMMV5_DEFAULT_ADDR, vel, acc, target_steps, 1);

    /* ── 6. 更新命令位置基准与状态 ── */
    g_track.target_steps       = target_steps;
    g_track.position_error     = delta;
    g_track.current_angle_mdeg = StepperTrack_StepsToAngle(target_steps);
    g_track.moving             = true;
    g_track.last_update_ms     = tick_ms;
}

void StepperTrack_Rearm(void)
{
    /* 每次用户重新按下 PA12 都显式恢复驱动器状态。即使软件没有锁存
     * fault，驱动器也可能因掉电、保护或上一帧异常而处于失能状态。 */
    EMMV5_ResetClog(EMMV5_DEFAULT_ADDR);
    EMMV5_Enable(EMMV5_DEFAULT_ADDR, true);

    g_track.target_angle_mdeg = 0;
    g_track.current_angle_mdeg = 0;
    g_track.target_steps = 0;
    g_track.position_error = 0;
    g_track.last_sent_angle_mdeg = 0;
    g_track.last_update_ms = 0;
    g_track.vel_band = 0;
    g_track.valid = false;
    g_track.moving = false;
    g_track.fault = false;
    g_track.state = TRACK_IDLE;
}

bool StepperTrack_IsBusy(void)
{
    /* Emm_V5 闭环电机无位置反馈, 以"是否近期下发过运动命令"表示忙碌 */
    return g_track.moving;
}

int32_t StepperTrack_GetPosition(void)
{
    /* 返回命令位置 (近似实际, Emm_V5 无位置读取) */
    return g_track.target_steps;
}

const stepper_track_t* StepperTrack_GetState(void)
{
    return &g_track;
}

void StepperTrack_EmergencyStop(void)
{
    EMMV5_Stop(EMMV5_DEFAULT_ADDR);
    g_track.state  = TRACK_IDLE;
    g_track.moving = false;
}
