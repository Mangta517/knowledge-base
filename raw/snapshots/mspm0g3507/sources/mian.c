/**
 * @file    mian.c
 * @brief   JY901S 姿态 + UART2 无线串口通讯 (MSPM0G3507)
 *
 *   架构: 应用层入口, 调用 interface/ 层的协议和传感器 BSP
 *
 *   UART0: K230 视觉模块  (PA10=TX, PA11=RX, 115200, 轮询)
 *   UART1: Emm_V5 闭环步进 (PA8=TX, PA9=RX, 115200, 发送为主)
 *   UART2: JY901S 传感器 (PB15=TX, PB16=RX, 19200, 轮询)
 *   UART3: 无线串口透传   (PB12=TX, PB13=RX, 115200, 中断+DMA)
 *   OLED:  硬件 I2C0 (PA0=SDA, PA1=SCL)
 *   KEY1:  PA12 (输入上拉, 按下=GND)
 *   KEY2:  PA13 (输入上拉, 按下=GND)
 *   LED1:  PB8 (GPIO 输出)
 *   LED2:  PB9 (GPIO 输出)
 *
 *   协议层: interface/bsp_uart2_proto.c
 *     - RX 队列: ISR 组帧并入队, 主循环取帧 + 自动应答
 *     - TX ring buffer: 主循环入队, TX 中断排空
 *     - 错误恢复: UART 硬件错误/超长包自动丢弃
 *
 *   传感器: interface/bsp_jy901s.c
 *     - JY901S_Poll() 轮询 UART2 获取角度
 *
 *   K230 视觉协议 (UART0):
 *     接收 "$<cx>,<cy>#" 帧格式 (兼容旧的 angle 第三字段)
 *     cx,cy: 钢珠坐标 (800x480)
 *     angle: 目标摆杆角度 (毫度, 正=右倾, 负=左倾)
 *
 *   Emm_V5 闭环步进电机 (UART1):
 *     interface/emmv5.c 发送协议帧控制闭环步进 (原 ESP32 图传已停用).
 */

#include "ti_msp_dl_config.h"
#include "clock.h"
#include "oled_software_i2c.h"
#include "bsp_jy901s.h"
#include "bsp_uart2_proto.h"
#include "emmv5.h"

#include "interrupt.h"
#include "pwmmotor.h"
#include "ax_encoder.h"
#include "../common/stall_protect.h"
#include "../common/pid.h"
#include "stepmotor_42.h"
#include "bsp_uart0_proto.h"
#include "../application/app_stepper_track.h"
#include "../application/app_line_follow.h"
#include "../application/pid_tuning.h"
#include <stdio.h>
#include <stdlib.h>

/* ═════════════════════════════════════════════════════════════════════
 *  看门狗 (由 MSPM0/interrupt.c 的 SysTick_Handler 检查)
 * ═════════════════════════════════════════════════════════════════════ */

volatile uint32_t g_watchdog_fed     = 1;
volatile bool     g_watchdog_enabled = false;

/* PA12 按键: 按下后使能所有电机 (一次性触发, 全局可见) */
volatile bool g_system_armed = false;

/* PA12/PA13 切换: 直流编码电机使能 (PA12=开, PA13=关, 全局可见) */
volatile bool g_dc_motor_enable = false;

/* 未武装时停止帧是否已发出 (沿触发一次, 避免每循环刷 FE 停止帧) */
static bool s_emg_stop_sent = false;

/* OLED 显示模式: 0=默认, 1=PA12循迹, 2=PA13平衡 */
volatile uint8_t g_disp_mode = 0;

/* 循迹启动标志: 0=未启动, 1=直行阶段, 2=PID循迹 */
static uint8_t  g_lf_phase    = 0;
static uint32_t g_lf_phase_ms = 0;
static bool     s_lf_stopped  = false;

/* ── K230 通信超时保护 ── */

#define K230_TIMEOUT_MS         150
static uint32_t g_k230_last_rx_ms = 0;
static bool     g_k230_timeout    = false;

/* ── 丢球保持: K230发-1时不立即清零, 连续N帧才认为真丢球 ── */
#define BALL_MISS_TOLERANCE    3       /* 连续3帧无效才清零 (约60ms@20ms间隔) */
static uint8_t s_ball_miss_cnt = 0;    /* 连续无效帧计数 */

/* ── 球速前馈预测: 解决"球速 > 识别速度"的滞后问题 ──
 * 每帧追踪球的X方向速度(低通滤波), 用 predicted_cx = cx + vx * pred_ms
 * 作为PID输入, 使系统"瞄准球将要去的位置"而非"球刚经过的位置". */
static int32_t  s_ball_last_cx    = -1;      /* 上一次有效坐标 (X), -1=无效 */
static int32_t  s_ball_last_ms    = 0;       /* 上一次有效坐标的时间戳 */
static float    s_ball_vx_smooth  = 0.0f;    /* 低通滤波后的球速 (px/ms) */
static float    s_angle_cmd_mdeg  = 0.0f;    /* 发送给电机的平滑目标角度 */

/* ── MSPM0 本地平衡 PID (K230只发钢珠坐标, PID在此计算) ── */
#define BAL_CENTER_X            400     /* 800宽画面中心; 若机构平衡点不在中心则校准 */
#define BAL_MIN_ERR_PX          8       /* 小偏差不强制动作 */
#define BAL_BREAKFREE_MAX_PX    30      /* 中心附近克服静摩擦 */
#define BAL_MIN_ANGLE_MDEG      300     /* 最小动作约5脉冲，越过位置死区 */
#define BAL_MAX_ANGLE_STEP_MDEG 150     /* 每帧目标角度最大变化 */
#define BALL_VX_MAX             2.0f    /* 球速限幅 (px/ms=2000px/s): 超过视为识别跳变 */
static Common_PID_Typedef g_balance_pid;
#define BALL_PREDICT_MAX_MS 160U

/* ═════════════════════════════════════════════════════════════════════
 *  步进电机测试模式 (互斥, 按优先级 STEPPER_SPIN_TEST > EMMV5_SPIN_TEST)
 *    STEPPER_SPIN_TEST = 1: 42步进连续旋转测试 (StepMotor42, 忽略K230)
 *    EMMV5_SPIN_TEST   = 1: Emm_V5 往返半圈测试 (忽略K230, 上电即跑)
 *    两者均为 0: K230 视觉角度跟踪 → Emm_V5 闭环步进 (PA12 门控)
 * ═════════════════════════════════════════════════════════════════════ */

#define STEPPER_SPIN_TEST  0
#define EMMV5_SPIN_TEST    0

#if STEPPER_SPIN_TEST

/* 连续旋转: 斜坡启动到目标频率, 42步进电机整步200步/转 */
#define SPIN_DIR_CW         0       /* 0=CW顺时针, 1=CCW逆时针 */
#define SPIN_FREQ_HZ        400     /* 400Hz=120RPM, 整步丝滑区; 800+扭矩不足会卡顿 */
#define SPIN_START_FREQ_HZ  20      /* 斜坡起步频率 (低扭矩高可靠) */
#define SPIN_ACCEL_HZ_MS    10      /* 加速斜率 (Hz/ms), 缓加速防起步堵转 */

/**
 * @brief 步进电机连续旋转测试: 一直往一个方向顺滑旋转
 *
 * 启动前先释放→锁定电机, 让转子归位到齿槽位置 (从错位起步会直接堵转).
 * 用 MoveToRamped + 极大目标做缓斜坡启动, 到达目标转速后一直转不停.
 */
static void StepperSpinTest(void)
{
    static bool s_started = false;

    StepMotor42_Poll();   /* 推进斜坡加减速状态机 */

    if (!s_started) {
        s_started = true;
        /* 先释放再锁定, 转子归位到齿槽位置, 避免从失步位置起步再次堵转 */
        StepMotor42_Enable(false);
        mspm0_delay_ms(50);
        StepMotor42_Enable(true);

        /* 目标设为极大值 → 缓加速到 SPIN_FREQ_HZ 后保持 CONST 一直转 */
        StepMotor42_MoveToRamped(SPIN_DIR_CW ? -INT32_MAX : INT32_MAX,
                                 SPIN_FREQ_HZ,
                                 SPIN_START_FREQ_HZ,
                                 SPIN_ACCEL_HZ_MS);
    }
}

#endif /* STEPPER_SPIN_TEST */

#if EMMV5_SPIN_TEST

/* Emm_V5/Emm_X42S 闭环步进往返半圈测试参数.
 * 注意: X42S 二代默认 X 固件, 位置命令按角度(0.1°)下发 (FB);
 *       Emm 固件按脉冲数下发 (FD). 固件类型启动时自动探测. */
#define EMMV5_HALF_TURN_PULSES     (EMMV5_PULSES_PER_REV / 2U)  /* 1600 脉冲 (Emm固件) */
#define EMMV5_HALF_TURN_01DEG      1800U                        /* 180.0° 半圈 (X固件) */
#define EMMV5_HALF_TURN_RPM        120U                          /* 往返速度 (Emm, RPM) */
#define EMMV5_HALF_TURN_VEL_01RPM  1200U                         /* 往返速度 (X, 0.1RPM=120.0) */
#define EMMV5_HALF_TURN_ACC        80U                           /* 加速度 (Emm) */
#define EMMV5_HALF_TURN_TIMEOUT_MS 3000U                         /* 到位超时 */

/* 测试状态 (文件级, 供主循环状态输出读取) */
static bool     s_emmv5_started     = false;
static uint8_t  s_emmv5_phase       = 0;   /* 0=CW, 1=CCW */
static uint32_t s_emmv5_cmd_ms      = 0;   /* 上次下发位置命令的时间 */
static uint32_t s_emmv5_swing_cnt   = 0;   /* 已完成的半圈次数 */
static uint32_t s_emmv5_reached_cnt = 0;   /* 到位(9F)回复次数 */
static uint32_t s_emmv5_fault_cnt   = 0;   /* 故障(E2/EE)回复次数 */
static uint8_t  s_emmv5_last_reply  = 0;   /* 0=无, 1=ACK, 2=REACH, 3=FAULT */

/* 固件探测状态机: 位置命令格式 Emm(FD脉冲) 与 X(FB角度) 不同,
 * 启动时发 Emm 探针, 回 EE 即为 X 固件, 回 02 即为 Emm 固件. */
typedef enum {
    EM_DETECT_INIT,       /* 待启动: 发共享初始化命令 */
    EM_DETECT_WAIT,       /* 等初始化命令回复 */
    EM_DETECT_PROBE,      /* 发 Emm 位置探针 (0脉冲, 不移动) */
    EM_DETECT_WAIT_PROBE, /* 等探针回复 */
    EM_RUN,               /* 正常往返 */
} emmv5_detect_state_t;

static emmv5_detect_state_t s_detect = EM_DETECT_INIT;
static uint32_t s_detect_ms   = 0;
static uint8_t  s_proto       = 0;   /* 0=Emm(FD), 1=X(FB) */
static uint8_t  s_last_func   = 0;   /* 最近回复的功能码 */
static uint8_t  s_last_status = 0;   /* 最近回复的状态字节 (02/9F/E2/EE) */

/* 打印一条 TX 命令的功能码 (收发跟踪) */
static void emmv5_dbg_tx(uint8_t func)
{
    char buf[24];
    snprintf(buf, sizeof(buf), "EMMV5 TX:%02X", func);
    UART2_Proto_Send(buf);
}

/* 回复帧回调: 每收到一帧完整回复就打印原始字节, 并记录 func/status */
static void emmv5_rx_trace_cb(const uint8_t *frm, uint8_t len)
{
    char buf[72];
    int m = snprintf(buf, sizeof(buf), "EMMV5 RX:");
    for (uint8_t i = 0; i < len && m >= 0 && m < (int)sizeof(buf) - 3; i++) {
        m += snprintf(buf + m, sizeof(buf) - (size_t)m, " %02X", frm[i]);
    }
    UART2_Proto_Send(buf);
    if (len >= 3) {
        s_last_func   = frm[1];
        s_last_status = frm[2];
    }
}

/* 固件探测: 非阻塞状态机, 探测完成前不跑往返 */
static void emmv5_detect_poll(void)
{
    uint32_t now = tick_ms;

    switch (s_detect) {
    case EM_DETECT_INIT:
        /* 使能/解堵转/清零 为两种固件共享命令, 同时验证校验(0x6B)与通讯 */
        EMMV5_Enable(EMMV5_DEFAULT_ADDR, true);    emmv5_dbg_tx(0xF3);
        EMMV5_ResetClog(EMMV5_DEFAULT_ADDR);       emmv5_dbg_tx(0x0E);
        EMMV5_ClearPosition(EMMV5_DEFAULT_ADDR);   emmv5_dbg_tx(0x0A);
        s_last_func = 0; s_last_status = 0;
        s_detect_ms = now;
        s_detect = EM_DETECT_WAIT;
        break;

    case EM_DETECT_WAIT:
        if ((uint32_t)(now - s_detect_ms) >= 400U) {
            s_last_func = 0; s_last_status = 0;
            s_detect = EM_DETECT_PROBE;
        }
        break;

    case EM_DETECT_PROBE:
        /* Emm 位置探针: FD 13字节, 0脉冲相对运动, 不会真的移动 */
        EMMV5_Position(EMMV5_DEFAULT_ADDR, 0, 100, 20, 0, 0);
        emmv5_dbg_tx(0xFD);
        s_detect_ms = now;
        s_detect = EM_DETECT_WAIT_PROBE;
        break;

    case EM_DETECT_WAIT_PROBE:
        if ((uint32_t)(now - s_detect_ms) >= 500U) {
            if (s_last_status == 0xEE) {
                UART2_Proto_Send("EMMV5: PROTO=X (FD-Emm rejected)\r\n");
                s_proto = 1;   /* 帧格式错误 → X 固件, 位置用 FB 角度 */
            } else {
                UART2_Proto_Send("EMMV5: PROTO=EMM\r\n");
                s_proto = 0;
            }
            s_detect = EM_RUN;
            s_emmv5_cmd_ms = tick_ms;
        }
        break;

    default:
        break;
    }
}

static void EmmV5HalfTurnTest(void)
{
    if (!s_emmv5_started) {
        s_emmv5_started = true;
        EMMV5_RX_SetFrameCallback(emmv5_rx_trace_cb);  /* 逐帧打印回复 */
    }

    /* 轮询电机回复: 到位(9F) / 故障(E2/EE) */
    bool reached, fault;
    EMMV5_RX_Poll();
    EMMV5_RX_GetFlags(&reached, &fault);

    /* 固件探测阶段: 探测完成前不跑往返 */
    if (s_detect != EM_RUN) {
        emmv5_detect_poll();
        return;
    }

    /* 正常运行: 记录调试计数 */
    if (fault) {
        s_emmv5_fault_cnt++;
        s_emmv5_last_reply = 3;
    } else if (reached) {
        s_emmv5_reached_cnt++;
        s_emmv5_last_reply = 2;
    }

    if (reached
        || (uint32_t)(tick_ms - s_emmv5_cmd_ms) >= EMMV5_HALF_TURN_TIMEOUT_MS) {
        /* 已到位(或超时): 换向, 绝对目标在 0 ↔ 半圈 间交替 */
        s_emmv5_phase ^= 1;
        s_emmv5_cmd_ms = tick_ms;
        s_emmv5_swing_cnt++;
        EMMV5_ResetClog(EMMV5_DEFAULT_ADDR);  emmv5_dbg_tx(0x0E);
        if (s_proto == 0) {
            /* Emm 固件: FD 脉冲, rel=1 绝对 */
            uint32_t tgt = (s_emmv5_phase == 0U) ? EMMV5_HALF_TURN_PULSES : 0U;
            EMMV5_Position(EMMV5_DEFAULT_ADDR, (tgt != 0U) ? 0 : 1,
                           EMMV5_HALF_TURN_RPM, EMMV5_HALF_TURN_ACC, tgt, 1);
            emmv5_dbg_tx(0xFD);
        } else {
            /* X 固件: FB 直通限速, 角度 0.1°, mode=1 绝对 */
            uint32_t ang = (s_emmv5_phase == 0U) ? EMMV5_HALF_TURN_01DEG : 0U;
            EMMV5_PositionX(EMMV5_DEFAULT_ADDR, (ang != 0U) ? 0 : 1,
                            EMMV5_HALF_TURN_VEL_01RPM, ang, 1, 0);
            emmv5_dbg_tx(0xFB);
        }
    }
}

#endif /* EMMV5_SPIN_TEST */

/* ═════════════════════════════════════════════════════════════════════
 *  main
 * ═════════════════════════════════════════════════════════════════════ */

int main(void)
{
    SYSCFG_DL_init();
    SysTick_Init();
    DMA_Init();

    /* ── OLED 先初始化 (I2C0: PA0=SDA, PA1=SCL) ── */
    OLED_Init();
    OLED_Clear();

    /*
     * ── Emm_V5 闭环步进电机 UART1 (PA8=TX, PA9=RX, 115200 8N1) ──
     *    原接 ESP32 图传模块, 已改为驱动闭环步进电机 (esp32_vision.c 保留未用).
     */
    EMMV5_UART1_Init();

    /* ── K230 视觉 UART0 协议解析初始化 (轮询模式) ── */
    UART0_Proto_Init();

    /*
     * ── 协议层初始化 (UART3: ISR RX + DMA TX, PB12=TX, PB13=RX) ──
     *
     * 内部会等待 ~3.5 秒让 CC2530 Zigbee 模块完成组网.
     */
    UART2_Proto_Init();

    /* ── UART2 配置 (JY901S 19200bps, PB15=TX, PB16=RX) ── */
    DL_UART_Main_disable(UART_2_INST);
    DL_UART_Main_disableInterrupt(UART_2_INST,
        DL_UART_MAIN_INTERRUPT_RX | DL_UART_MAIN_INTERRUPT_TX);
    DL_UART_Main_setOversampling(UART_2_INST, DL_UART_OVERSAMPLING_RATE_16X);
    {
        uint32_t div  = CPUCLK_FREQ / (16 * 19200);
        uint32_t fbrd = ((CPUCLK_FREQ % (16 * 19200)) * 64 + (16 * 19200 / 2))
                        / (16 * 19200);
        DL_UART_Main_setBaudRateDivisor(UART_2_INST, div, fbrd);
    }
    DL_UART_Main_enableFIFOs(UART_2_INST);
    DL_UART_Main_setRXFIFOThreshold(UART_2_INST, DL_UART_RX_FIFO_LEVEL_ONE_ENTRY);
    DL_UART_Main_enable(UART_2_INST);

    /* JY901S: 9轴模式 */
    JY901S_SetAxis6(JY901S_AXIS6_9AXIS);
    mspm0_delay_ms(100);

    OLED_ShowString(0, 2, (uint8_t *)"Mode:0 DC:OFF", 16);

    /* 电磁铁已禁用 — PB1 现为编码器 A 相 B */

    /* ── 电机 + 编码器 + 堵转保护 ── */
    PWMMotor_Init();
    AX_ENCODER_A_Init();
    AX_ENCODER_B_Init();
    StallProtect_Init();

    /* ── Emm_V5 步进电机: K230 角度跟踪 (UART1 由 EMMV5_UART1_Init 已配置) ── */
    StepperTrack_Init();

    /* ── 纯平衡模式: 上电自动武装 — K230 一有数据就开始跟踪.
     * PA13 可随时按下停止 (un-arm → 步进紧急停止). ── */
    g_system_armed  = true;
    s_emg_stop_sent = false;

    /* ── 本地平衡 PID: 钢珠X坐标 → 目标倾斜角(mdeg) ── */
    Common_PID_Init_WithGains(&g_balance_pid, 0.5f, 0.0f, 0.5f);
    g_balance_pid.Out_Max       = (float)TRACK_MAX_ANGLE_MDEG;  /* ±10° 机械限幅 */
    g_balance_pid.Integral_Limit = 1000.0f;
    g_balance_pid.D_RC           = 0.06f;  /* 适配约20ms视觉周期的D项滤波 */

    /* ── PID 循迹应用 (轮子基准 15%, ≥3路循迹停止) ── */
    AppLineFollow_Init();

    /* ── PID 调参模块初始化 (UART3命令控制) ── */
    PIDTune_Init();

    /* ── 状态 LED 初始状态: LED1(PB8)=灭, LED2(PB9)=灭 (高电平=灭) ── */
    DL_GPIO_setPins(GPIOB, DL_GPIO_PIN_8 | DL_GPIO_PIN_9);

    /* ── Emm_V5 步进电机使能由 StepperTrack_Init() 完成 ── */

    g_watchdog_enabled = true;

    char    buf[32];
    char    pkt[UART2_PROTO_BUF_SIZE];
    uint8_t pkt_len;

    while (1) {
        g_watchdog_fed = 1;

        /* ── PA12: 纯平衡武装 — 使能步进电机 + K230 视觉跟踪 ── */
        {
            static bool s_pa12_last = true;
            bool pa12 = (DL_GPIO_readPins(GPIO_KEY_PORT, GPIO_KEY_PIN_SW1_PIN) != 0U);
            if (s_pa12_last && !pa12) {
                StepperTrack_Rearm();
                g_system_armed    = true;    /* 使能步进电机 + K230 跟踪 */
                s_emg_stop_sent   = false;   /* 重新武装, 允许下次进入未武装态时再停一次 */
                g_disp_mode = 1;

                /* 发送当前平衡PID参数到电脑 (调参已本地化, 无需同步K230) */
                {
                    char init_msg[200];
                    int n = PIDTune_Snapshot(init_msg, sizeof(init_msg));
                    UART2_Proto_Send(init_msg);
                }

                UART0_Proto_SendTask(K230_TASK_HOME);  /* 启动 K230 视觉跟踪 */
            }
            s_pa12_last = pa12;
        }

        /* ── PA13: 停止平衡 (un-arm, 未武装态会触发步进紧急停止) ── */
        {
            static bool s_pa13_last = true;
            bool pa13 = (DL_GPIO_readPins(GPIO_KEY_PORT, GPIO_KEY_PIN_SW2_PIN) != 0U);
            if (s_pa13_last && !pa13) {
                g_system_armed = false;
                g_disp_mode = 2;
            }
            s_pa13_last = pa13;
        }

        /* ── 协议层维护 (TX drain + RX 空闲帧封存, 非阻塞) ── */
        UART2_Proto_Poll();

        /* ── Emm_V5 步进电机: 发送式驱动, 无轮询 (动作待定) ── */

        /* ── UART3 无线串口数据处理: 消费帧 + PID调参命令 ── */
        {
            while (UART2_Proto_Recv(pkt, &pkt_len)) {
                if (pkt_len > 0U && pkt_len < UART2_PROTO_BUF_SIZE) {
                    pkt[pkt_len] = '\0';
                    if (PIDTune_ProcessCommand((const char *)pkt)) {
                        /* TUNE命令: 发送详细响应 */
                        UART2_Proto_Send(PIDTune_GetResponse());
                    } else {
                        /* 非TUNE命令: 简单回显 */
                        UART2_Proto_Send("OK\r\n");
                    }
                }
            }
            UART2_Proto_ProcessDrops();
        }
        /* ── JY901S 轮询 ── */
#if 0 /* JY901S polling paused while tuning vision balance */
        JY901S_Poll();
        if (jy901s_updated_flags & JY901S_FLAG_ANGLE) {
            float r, p, y;
            __disable_irq();
            r = jy901s_angle_data.roll;
            p = jy901s_angle_data.pitch;
            y = jy901s_angle_data.yaw;
            jy901s_updated_flags &= ~JY901S_FLAG_ANGLE;
            __enable_irq();

            (void)r; (void)p; (void)y;
            (void)buf;
        }
#endif

        /* ── OLED 模式显示 (仅变化时刷新) ── */
        {
            static uint8_t last_mode = 0xFF;
            static bool     last_dc  = false;
            uint8_t m = g_disp_mode;
            bool    dc = g_dc_motor_enable;
            if (m != last_mode || dc != last_dc) {
                last_mode = m;
                last_dc   = dc;
                snprintf(buf, sizeof(buf), "Mode:%d  DC:%s ",
                         m, dc ? "ON " : "OFF");
                OLED_ShowString(0, 2, (uint8_t *)buf, 16);
            }
        }

        /* ── PID 循迹: 读循迹 → PID → 差速 → 驱动轮子 ── */
        static AppLineFollow_State_t lf_state;
#if 0  /* 阶段切换调试 */
        {
            static uint8_t last_phase = 0xFF;
            if (g_lf_phase != last_phase) {
                last_phase = g_lf_phase;
                char dbg[32];
                snprintf(dbg, sizeof(dbg), "LF phase:%d dc:%d ms:%lu\r\n",
                         g_lf_phase, g_dc_motor_enable, (unsigned long)tick_ms);
                UART2_Proto_Send(dbg);
            }
        }
#endif
        if (!g_dc_motor_enable) {
            PWMMotor_Set(0, 0);
        } else if (g_lf_phase == 1) {
            /* 阶段1: 500ms直行, 10% */
            PWMMotor_Set(10.0f, 10.0f);
            if ((uint32_t)(tick_ms - g_lf_phase_ms) >= 500U) {
                g_lf_phase = 2;
            }
        } else {
            /* 阶段2: PID循迹 */
            uint8_t bits = lf_state.track_bits;
            uint8_t n = (bits & 1) + ((bits>>1)&1) + ((bits>>2)&1) + ((bits>>3)&1)
                      + ((bits>>4)&1) + ((bits>>5)&1) + ((bits>>6)&1) + ((bits>>7)&1);

            /* 停止线检测 */
            bool stop_line = (lf_state.distance_cm > 560.0f
                           && lf_state.distance_cm < 600.0f && n >= 3);

            if (stop_line) {
                if (!s_lf_stopped) {
                    /* 电机停止 (停止线首次触发): OLED 显示总时长 */
                    AppLineFollow_ShowRunTime();
                }
                s_lf_stopped = true;
            }

            if (s_lf_stopped) {
                PWMMotor_Set(0, 0);
            } else if (lf_state.track_bits == 0xFF) {
                PWMMotor_Set(30.0f, 30.0f);
            } else {
                AppLineFollow_Update(tick_ms, jy901s_angle_data.yaw, &lf_state);
            }
        }

#if 0  /* 关闭: JY901S 陀螺仪调试 */
        {
            static uint32_t last_gyro_tx;
            if ((uint32_t)(tick_ms - last_gyro_tx) >= 200U) {
                last_gyro_tx = tick_ms;
                uint8_t raw[16]; int ri = 0;
                while (!DL_UART_Main_isRXFIFOEmpty(UART_2_INST) && ri < 16)
                    raw[ri++] = (uint8_t)DL_UART_Main_receiveData(UART_2_INST);
                raw[ri] = 0;
                char gbuf[160];
                snprintf(gbuf, sizeof(gbuf),
                    "GYRO: Y=%+6.1f | RX%d: %02X %02X %02X %02X %02X %02X %02X %02X\r\n",
                    (double)jy901s_angle_data.yaw, ri,
                    raw[0], raw[1], raw[2], raw[3],
                    raw[4], raw[5], raw[6], raw[7]);
                UART2_Proto_Send(gbuf);
            }
        }
#endif

        /* ════════════════════════════════════════════════════════════════
         *  K230 视觉数据 → 42步进电机角度跟踪 (参考项目架构)
         *
         *  K230 通过 UART0 发送 "$<cx>,<cy>#" 帧:
         *    cx,cy: 钢珠坐标 (800x480), -1=无钢珠
         *  MSPM0 根据 cx 计算本地平衡 PID，再下发摆杆角度。
         *
         *  步进电机跟踪由 PA12 门控: 未按下按键前电机保持静止,
         *  按下 PA12 (g_system_armed=1) 后才开始轮询K230并驱动电机.
         *  PA12 同时发送 K230_TASK_HOME 启动K230视觉任务.
         *
         *  超时保护: 超过 K230_TIMEOUT_MS 无数据 → 自动回中
         * ════════════════════════════════════════════════════════════════ */

#if STEPPER_SPIN_TEST
        /* ── 步进电机连续旋转测试: 一直往一个方向转 ── */
        StepperSpinTest();

        /* ── 无线串口输出电机状态 (每200ms) ── */
        {
            static uint32_t last_sm_tx;
            if ((uint32_t)(tick_ms - last_sm_tx) >= 200U) {
                last_sm_tx = tick_ms;

                const stepper_motor_t *m   = StepMotor42_GetMotor();
                int32_t  pos  = StepMotor42_GetPosition();
                int32_t  tgt  = m->target_steps;
                uint32_t freq = StepMotor42_GetFrequency();

                const char *st;
                switch (m->state) {
                    case STEPPER_IDLE:     st = "IDLE"; break;
                    case STEPPER_ACCEL:    st = "ACC";  break;
                    case STEPPER_CONST:    st = "CON";  break;
                    case STEPPER_DECEL:    st = "DEC";  break;
                    case STEPPER_STOPPING: st = "STP";  break;
                    default:               st = "?";    break;
                }

                char sbuf[96];
                snprintf(sbuf, sizeof(sbuf),
                    "SM: pos=%+4ld tgt=%+4ld dir=%s %s f=%luHz\r\n",
                    (long)pos, (long)tgt, m->direction ? "CCW" : "CW ",
                    st, (unsigned long)freq);
                UART2_Proto_Send(sbuf);
            }
        }
#elif EMMV5_SPIN_TEST
        /* ── Emm_V5 往返半圈测试: CW 半圈 → CCW 半圈 循环 ── */
        UART0_Proto_Poll();   /* 持续轮询K230帧, 防UART0 FIFO溢出 */
        EmmV5HalfTurnTest();

        /* ── 无线串口输出测试状态 (每1s 心跳, 帧级细节见 TX:/RX: 跟踪行) ── */
        {
            static uint32_t last_em_tx;
            if ((uint32_t)(tick_ms - last_em_tx) >= 1000U) {
                last_em_tx = tick_ms;

                const char *rep;
                switch (s_emmv5_last_reply) {
                    case 3:  rep = "FAULT"; break;
                    case 2:  rep = "REACH"; break;
                    case 1:  rep = "ACK";   break;
                    default: rep = "NONE";  break;
                }

                char ebuf[96];
                snprintf(ebuf, sizeof(ebuf),
                    "EMMV5[%s]: %s cnt=%lu | last=%s reached=%lu fault=%lu"
                    " | since=%lums\r\n",
                    s_proto ? "X" : "EMM",
                    s_emmv5_phase ? "CCW" : "CW ",
                    (unsigned long)s_emmv5_swing_cnt,
                    rep,
                    (unsigned long)s_emmv5_reached_cnt,
                    (unsigned long)s_emmv5_fault_cnt,
                    (unsigned long)(tick_ms - s_emmv5_cmd_ms));
                UART2_Proto_Send(ebuf);
            }
        }
#else
        /* ── 轮询K230数据: 非阻塞读UART0 FIFO, 协议组帧+解析 (始终运行, 防FIFO溢出) ── */
        UART0_Proto_Poll();

        if (g_system_armed) {
            /* ── 有新数据: 直接传递给步进电机跟踪控制器 ── */
            if (g_uart0_data.fresh) {
                g_uart0_data.fresh = false;
                g_k230_last_rx_ms = tick_ms;
                g_k230_timeout = false;

                if (g_uart0_data.valid) {
                    s_ball_miss_cnt = 0;    /* 有效帧: 清零丢球计数 */
                    /* ── 增益调度 + 速度前馈 + PID 分离架构 ──
                     *
                     * 增益调度 (Gain Scheduling):
                     *   |err| <= gs_near_px: 用近区增益 (小Kp, 精细收敛)
                     *   |err| >  gs_near_px: 用远区增益 (大Kp, 快速拉回)
                     *   边界附近线性插值过渡, 避免跳变
                     *
                     * 前馈: ff_angle = vx * pred_ms * Kp_eff (量纲与P项一致)
                     * PID:  用原始 cx 算 P+D, D项不受前馈放大 */
                    const pid_tuning_t *pt = PIDTune_GetParams();

                    /* ── 计算有效增益 (增益调度 + 线性插值) ── */
                    int32_t err_px = g_uart0_data.cx - BAL_CENTER_X;
                    float abs_err = (float)abs(err_px);
                    float gs_near = (float)pt->gs_near_px;
                    /* ratio: 0=完全近区, 1=完全远区, 中间线性插值 */
                    float ratio;
                    if (gs_near <= 0.0f) {
                        ratio = 1.0f;
                    } else if (abs_err <= gs_near) {
                        ratio = abs_err / gs_near;
                    } else {
                        ratio = 1.0f;
                    }
                    float kp_eff = pt->k230_kp_near
                                 + (pt->k230_kp - pt->k230_kp_near) * ratio;
                    float kd_eff = pt->k230_kd_near
                                 + (pt->k230_kd - pt->k230_kd_near) * ratio;

                    Common_PID_Set(&g_balance_pid, kp_eff, pt->k230_ki, kd_eff);
                    g_balance_pid.Out_Max = (float)pt->k230_max_angle;

                    /* 计算平滑球速: 低通滤波 + 限幅防噪声尖峰 */
                    float cur_vx = 0.0f;
                    if (s_ball_last_cx >= 0) {
                        int32_t dt = (int32_t)(tick_ms - s_ball_last_ms);
                        if (dt > 0 && dt < 1000) {
                            float raw_vx = (float)(g_uart0_data.cx - s_ball_last_cx)
                                         / (float)dt;  /* px/ms */
                            if (raw_vx >  BALL_VX_MAX) raw_vx =  BALL_VX_MAX;
                            if (raw_vx < -BALL_VX_MAX) raw_vx = -BALL_VX_MAX;
                            s_ball_vx_smooth = s_ball_vx_smooth
                                             * (1.0f - pt->k230_ff_alpha)
                                             + raw_vx * pt->k230_ff_alpha;
                            cur_vx = s_ball_vx_smooth;
                        }
                    }
                    s_ball_last_cx = g_uart0_data.cx;
                    s_ball_last_ms = tick_ms;

                    /* PID 用原始坐标算 P+D */
                    float ang = Common_PID_Calc(&g_balance_pid,
                                                (float)g_uart0_data.cx,
                                                (float)BAL_CENTER_X,
                                                (float)tick_ms);

                    /* 前馈补偿角: 用有效Kp, 量纲与P项一致 */
                    float ff_angle = cur_vx * pt->k230_ff_pred_ms * kp_eff;
                    ang += ff_angle;

                    /* 软限幅 (渐变饱和): 大输出时逐渐衰减, 避免硬顶限幅导致过冲.
                     *
                     * 策略: 分段线性
                     *   |ang| <= soft_knee (60% max):  完全线性, 不衰减
                     *   |ang| >  soft_knee:           线性衰减到 max (斜率降为1/3)
                     *
                     * 效果: 小偏差正常响应, 大偏差输出渐缓爬升到max而非猛撞 */
                    {
                        float max_ang  = (float)pt->k230_max_angle;
                        float soft_knee = max_ang * 0.6f;   /* 60%以下不衰减 */
                        float abs_ang  = (ang >= 0) ? ang : -ang;
                        float sign     = (ang >= 0) ? 1.0f : -1.0f;

                        if (abs_ang > soft_knee && max_ang > 0.0f) {
                            /* 超过knee的部分, 斜率降为1/3: 每超出3mdeg只增加1mdeg */
                            float excess = abs_ang - soft_knee;
                            float compressed = soft_knee + excess * 0.33f;
                            if (compressed > max_ang) compressed = max_ang;
                            ang = sign * compressed;
                        } else {
                            /* knee以内: 不限幅 (但兜底防异常) */
                            if (ang >  max_ang) ang =  max_ang;
                            if (ang < -max_ang) ang = -max_ang;
                        }
                    }

                    /* 破静摩擦: 仅当偏差很小且PID输出过小时兜底 */
                    {
                        /* Slightly stronger breakaway impulse for static friction. */
                        #undef BAL_BREAKFREE_MAX_PX
                        #define BAL_BREAKFREE_MAX_PX 50
                        #undef BAL_MIN_ANGLE_MDEG
                        #define BAL_MIN_ANGLE_MDEG 500
                        if (abs(err_px) >= BAL_MIN_ERR_PX
                            && abs(err_px) <= BAL_BREAKFREE_MAX_PX
                            && ang > -BAL_MIN_ANGLE_MDEG
                            && ang <  BAL_MIN_ANGLE_MDEG) {
                            ang = (err_px > 0) ? (float)BAL_MIN_ANGLE_MDEG
                                              : -(float)BAL_MIN_ANGLE_MDEG;
                        }
                    }
                    {
                        /* Faster command slew after the PID output is calculated. */
                        #undef BAL_MAX_ANGLE_STEP_MDEG
                        #define BAL_MAX_ANGLE_STEP_MDEG 550
                        float delta_cmd = ang - s_angle_cmd_mdeg;
                        if (delta_cmd > BAL_MAX_ANGLE_STEP_MDEG)
                            delta_cmd = BAL_MAX_ANGLE_STEP_MDEG;
                        else if (delta_cmd < -BAL_MAX_ANGLE_STEP_MDEG)
                            delta_cmd = -BAL_MAX_ANGLE_STEP_MDEG;
                        s_angle_cmd_mdeg += delta_cmd;
                        StepperTrack_SetTarget((int32_t)s_angle_cmd_mdeg, true);
                    }
                } else {
                    /* 球无效: 不立即清零, 连续N帧才认为真丢球.
                     * K230的YOLO偶发漏检不该打断PID控制. */
                    s_ball_miss_cnt++;
                    /* During a short dropout, extrapolate the last position using
                     * the filtered ball velocity, then continue the same slew-limited
                     * angle command. A hard time limit prevents blind motion. */
                    if (s_ball_last_cx >= 0) {
                        uint32_t age_ms = (uint32_t)(tick_ms - s_ball_last_ms);
                        if (age_ms <= BALL_PREDICT_MAX_MS) {
                            const pid_tuning_t *pt_pred = PIDTune_GetParams();
                            float pred_cx = (float)s_ball_last_cx
                                          + s_ball_vx_smooth * (float)age_ms;
                            if (pred_cx < 0.0f) pred_cx = 0.0f;
                            if (pred_cx > 800.0f) pred_cx = 800.0f;
                            float pred_ang = (pred_cx - (float)BAL_CENTER_X)
                                           * pt_pred->k230_kp;
                            if (pred_ang > (float)pt_pred->k230_max_angle)
                                pred_ang = (float)pt_pred->k230_max_angle;
                            if (pred_ang < -(float)pt_pred->k230_max_angle)
                                pred_ang = -(float)pt_pred->k230_max_angle;
                            float d = pred_ang - s_angle_cmd_mdeg;
                            if (d > 400.0f) d = 400.0f;
                            if (d < -400.0f) d = -400.0f;
                            s_angle_cmd_mdeg += d;
                            StepperTrack_SetTarget((int32_t)s_angle_cmd_mdeg, true);
                        }
                    }
                    /* Hold the last target through short YOLO dropouts. */
                    #undef BALL_MISS_TOLERANCE
                    #define BALL_MISS_TOLERANCE 8
                    if (s_ball_miss_cnt >= BALL_MISS_TOLERANCE) {
                        s_ball_last_cx   = -1;
                        s_ball_vx_smooth = 0.0f;
                        s_angle_cmd_mdeg = 0.0f;
                        Common_PID_Clear(&g_balance_pid);
                        StepperTrack_SetTarget(0, false);
                    }
                    /* 保持期内: 不更新目标, 电机维持上一次角度 */
                }
            }

            /* ── K230 超时保护 ── */
            if (!g_k230_timeout
                && (uint32_t)(tick_ms - g_k230_last_rx_ms) >= K230_TIMEOUT_MS) {
                g_k230_timeout = true;
                StepperTrack_SetTarget(0, false);
            }

            /* ── 推进步进电机角度跟踪 (内部下发 Emm_V5 串口位置命令) ── */
            StepperTrack_Update(tick_ms);
        } else {
            /* 未按键(未武装): 电机保持静止, 丢弃K230目标.
             * 停止命令只在刚进入未武装态时发一次, 避免每循环刷 FE 停止帧. */
            g_uart0_data.fresh = false;
            g_k230_timeout     = false;
            if (!s_emg_stop_sent) {
                s_emg_stop_sent = true;
                StepperTrack_EmergencyStop();
            }
        }
#endif /* STEPPER_SPIN_TEST */

#if 0  /* 关闭: 编码器调试 (仅保留循迹 LF:) */
        /* ════════════════════════════════════════════════════════════════
         *  编码器调试 (每 200ms 通过无线串口发送)
         * ════════════════════════════════════════════════════════════════ */
        {
            static uint32_t last_tx;
            static int32_t  last_ea, last_eb;
            if ((uint32_t)(tick_ms - last_tx) >= 200U) {
                uint32_t dt = (uint32_t)(tick_ms - last_tx);
                last_tx = tick_ms;

                int32_t ea = AX_ENCODER_A_GetCount();
                int32_t eb = AX_ENCODER_B_GetCount();
                int32_t da = ea - last_ea;
                int32_t db = eb - last_eb;
                last_ea = ea;
                last_eb = eb;

                float rpm_a = AX_ENCODER_CountsToRPM(da, dt);
                float rpm_b = AX_ENCODER_CountsToRPM(db, dt);

                /* 引脚电平 */
                uint8_t pa = (GPIOB->DIN31_0 & DL_GPIO_PIN_0)  ? 1 : 0;
                uint8_t pb = (GPIOB->DIN31_0 & DL_GPIO_PIN_1)  ? 1 : 0;
                uint8_t pc = (GPIOB->DIN31_0 & DL_GPIO_PIN_21) ? 1 : 0;
                uint8_t pd = (GPIOA->DIN31_0 & DL_GPIO_PIN_30) ? 1 : 0;

                char ebuf[96];
                snprintf(ebuf, sizeof(ebuf),
                    "ENC A:%+6ld d=%+5ld %+6.0frpm | "
                    "B:%+6ld d=%+5ld %+6.0frpm | "
                    "PB0=%d PB1=%d PB21=%d PA30=%d ISR=%lu\r\n",
                    (long)ea, (long)da, (double)rpm_a,
                    (long)eb, (long)db, (double)rpm_b,
                    pa, pb, pc, pd,
                    (unsigned long)g_enc_isr_count);
                UART2_Proto_Send(ebuf);
            }
        }
#endif /* 编码器调试 */

#if 0  /* 关闭: 循迹调试 */
        {
            static uint32_t last_lf_tx;
            if ((uint32_t)(tick_ms - last_lf_tx) >= 200U) {
                last_lf_tx = tick_ms;
                AppLineFollow_Debug(&lf_state);
            }
        }
#endif

#if 1  /* 步进平衡调试: 无线串口输出 武装态/K230目标/电机跟踪状态 (每200ms) */
        {
            static uint32_t last_sm_tx;
            if ((uint32_t)(tick_ms - last_sm_tx) >= 200U) {
                last_sm_tx = tick_ms;

                const stepper_track_t *tr = StepperTrack_GetState();
                int32_t cur_steps  = StepperTrack_GetPosition();
                int32_t cur_angle  = tr->current_angle_mdeg;
                int32_t tgt_angle  = tr->target_angle_mdeg;
                int32_t tgt_steps  = tr->target_steps;
                int32_t err_steps  = tr->position_error;

                /* ── K230 数据 + 速度前馈信息 ── */
                int32_t k_ang = g_uart0_data.angle_mdeg;
                int16_t k_cx  = g_uart0_data.cx;
                int16_t k_cy  = g_uart0_data.cy;
                bool    k_ok  = g_uart0_data.valid;

                /* 预测位置和球速 (用于调试输出) */
                const pid_tuning_t *pt_debug = PIDTune_GetParams();
                int32_t pred_cx = k_cx;
                int32_t vx_tenth = 0;  /* 速度 × 10 (即每10ms移动的像素) */
                if (s_ball_last_cx >= 0) {
                    pred_cx = k_cx + (int32_t)(s_ball_vx_smooth
                                * pt_debug->k230_ff_pred_ms);
                    vx_tenth = (int32_t)(s_ball_vx_smooth * 10.0f);
                }

                /* ── 跟踪状态 ── */
                const char *st_str;
                switch (tr->state) {
                    case TRACK_IDLE:     st_str = "IDLE";  break;
                    case TRACK_MOVING:   st_str = "MOV";   break;
                    case TRACK_SETTLING: st_str = "SET";   break;
                    default:             st_str = "?";     break;
                }
                const char *to_str  = g_k230_timeout ? " TO" : "";

                /* ── 上电读回的电机位置 (本次上电的 0°基准; 未读到显示 NO,
                 *   零点校验失败加 '?' 后缀) ── */
                char boot_str[24];
                if (tr->startup_position_valid) {
                    snprintf(boot_str, sizeof(boot_str), "%+ld%s",
                             (long)tr->startup_position_mdeg,
                             tr->startup_zero_ok ? "" : "?");
                } else {
                    snprintf(boot_str, sizeof(boot_str), "NO");
                }

                /* ── 格式: 武装态 | 跟踪状态 | boot | K230 | 预测 | 角度 | 脉冲 | 电机回复 ── */
                char sbuf[280];
                int n = snprintf(sbuf, sizeof(sbuf),
                    "SM[%s] %s%s boot=%s | K230:(%d,%d) ok=%d pred=%ld vx=%ld |"
                    " ang: tgt=%-5ld cur=%-5ld | stp: tgt=%-4ld cur=%-4ld err=%-4ld | rx=",
                    g_system_armed ? "ARM" : "OFF", st_str, to_str,
                    boot_str,
                    k_cx, k_cy, k_ok, (long)pred_cx, (long)vx_tenth,
                    (long)tgt_angle, (long)cur_angle,
                    (long)tgt_steps, (long)cur_steps, (long)err_steps);

                /* 附上驱动板最近一帧回复: [addr][func][status][0x6B]
                 * 02=命令正确 9F=到位 E2=堵转/条件不满足 EE=格式错误 */
                uint8_t frm[16]; uint8_t flen = 0;
                EMMV5_RX_GetLastFrame(frm, &flen);
                for (uint8_t i = 0; i < flen
                     && n >= 0 && n < (int)sizeof(sbuf) - 3; i++) {
                    n += snprintf(sbuf + n, sizeof(sbuf) - (size_t)n,
                                  "%02X ", frm[i]);
                }
                UART2_Proto_Send(sbuf);
            }
        }
#endif /* 步进电机 + K230 平衡调试 */

        /* ── Emm_V5 步进电机: 动作待定, 预留位置 ──
         * 例: EMMV5_Velocity(1, 0, 300, 100);            // 速度模式 300RPM CW
         *     EMMV5_Position(1, 0, 300, 100,
         *                    EMMV5_PULSES_PER_REV, 0);   // 相对运动1圈
         */

    }
}
