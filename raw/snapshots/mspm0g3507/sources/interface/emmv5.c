/**
 * @file    emmv5.c
 * @brief   张大头 Emm_V5 闭环步进电机驱动实现 (串口控制)
 *
 * 命令帧结构 (与 STM32 参考工程一致):
 *   [地址] [功能码] [参数...] [0x6B 校验字节]
 *
 * 功能码:
 *   0xF3  使能控制      (6 字节)  addr F3 AB state snF 6B
 *   0x0E  解除堵转保护  (4 字节)  addr 0E 52 6B
 *   0xFE  立即停止      (5 字节)  addr FE 98 snF 6B
 *   0xF6  速度模式      (8 字节)  addr F6 dir velH velL acc snF 6B
 *   0xFD  位置模式      (13 字节) addr FD dir velH velL acc clk[4] rel snF 6B
 *
 * 参数约定:
 *   dir  : 0=CW, 非0=CCW
 *   vel  : RPM, 高字节在前
 *   acc  : 0-255, 0=直接启动
 *   clk  : 脉冲数 (默认16细分 3200=1圈), 4字节大端
 *   rel  : 0=相对上一目标, 1=绝对, 2=相对当前实时位置
 *   snF  : 多机同步标志, 单电机恒为 0
 */

#include "emmv5.h"
#include "clock.h"   /* mspm0_delay_ms */

/* ========================================================================
 *  UART1 发送
 *
 *  重要: 驱动板串口解析器用"空闲间隔"判帧 (帧间需有 ~2ms 以上空闲),
 *  命令背靠背连发会被当作一帧畸形命令 → 回复 01 00 EE 6B (帧格式错误).
 *  实测: 单独发 FD 位置命令 → 01 FD 02 6B 正常; 紧跟 0E 后连发 → EE.
 *  因此每条命令发完后延时 EMMV5_TX_GAP_MS, 保证帧间空闲.
 * ======================================================================== */

#define EMMV5_TX_GAP_MS  10U

static void emmv5_send_frame(const uint8_t *frame, uint8_t len)
{
    for (uint8_t i = 0; i < len; i++) {
        DL_UART_Main_transmitDataBlocking(UART_1_INST, frame[i]);
    }
    mspm0_delay_ms(EMMV5_TX_GAP_MS);
}

/* ========================================================================
 *  UART1 初始化
 * ======================================================================== */

void EMMV5_UART1_Init(void)
{
    /* SysConfig (SYSCFG_DL_init) 已配置 UART1 为 115200-8N1 并使能.
     * 这里做最小化重初始化: FIFO + 清除接收错误标志. */
    DL_UART_Main_disable(UART_1_INST);
    DL_UART_Main_enableFIFOs(UART_1_INST);
    DL_UART_Main_setRXFIFOThreshold(UART_1_INST,
        DL_UART_RX_FIFO_LEVEL_ONE_ENTRY);

    /* 清除可能残留的接收错误标志 (发送为主, 不使能接收中断;
     * 电机回复若占满RX FIFO只会产生无害的overrun, 不影响TX) */
    DL_UART_Main_clearInterruptStatus(UART_1_INST,
        DL_UART_INTERRUPT_OVERRUN_ERROR |
        DL_UART_INTERRUPT_BREAK_ERROR |
        DL_UART_INTERRUPT_PARITY_ERROR |
        DL_UART_INTERRUPT_FRAMING_ERROR);

    DL_UART_Main_enable(UART_1_INST);

    EMMV5_RX_Reset();
}

/* ========================================================================
 *  命令实现
 * ======================================================================== */

void EMMV5_Enable(uint8_t addr, bool on)
{
    uint8_t cmd[6] = { addr, 0xF3, 0xAB, (uint8_t)on, 0, 0x6B };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_ResetClog(uint8_t addr)
{
    uint8_t cmd[4] = { addr, 0x0E, 0x52, 0x6B };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_Stop(uint8_t addr)
{
    uint8_t cmd[5] = { addr, 0xFE, 0x98, 0, 0x6B };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_ClearPosition(uint8_t addr)
{
    /* 5.2.3 将当前位置角度清零: 绝对坐标零点 = 当前机械位置 */
    uint8_t cmd[4] = { addr, 0x0A, 0x6D, 0x6B };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_Velocity(uint8_t addr, uint8_t dir, uint16_t vel, uint8_t acc)
{
    uint8_t cmd[8] = {
        addr, 0xF6, dir,
        (uint8_t)(vel >> 8), (uint8_t)(vel),
        acc, 0, 0x6B
    };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_Position(uint8_t addr, uint8_t dir, uint16_t vel, uint8_t acc,
                    uint32_t pulses, uint8_t rel)
{
    uint8_t cmd[13] = {
        addr, 0xFD, dir,
        (uint8_t)(vel >> 8), (uint8_t)(vel),
        acc,
        (uint8_t)(pulses >> 24), (uint8_t)(pulses >> 16),
        (uint8_t)(pulses >> 8),  (uint8_t)(pulses),
        rel, 0, 0x6B
    };
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_PositionSigned(uint8_t addr, uint16_t vel, uint8_t acc,
                          int32_t signed_pulses, uint8_t rel)
{
    uint8_t dir = (signed_pulses < 0) ? 1U : 0U;
    uint32_t pulses = (signed_pulses < 0)
        ? (uint32_t)(-(int64_t)signed_pulses)
        : (uint32_t)signed_pulses;

    EMMV5_Position(addr, dir, vel, acc, pulses, rel);
}

void EMMV5_PositionX(uint8_t addr, uint8_t dir, uint16_t vel_01rpm,
                     uint32_t angle_01deg, uint8_t mode, uint8_t snF)
{
    /* X 固件 5.3.8 直通限速: [Addr][FB][dir][vel 0.1RPM(2)][angle 0.1°(4)][mode][snF][6B] */
    uint8_t cmd[12] = {
        addr, 0xFB, dir,
        (uint8_t)(vel_01rpm >> 8), (uint8_t)(vel_01rpm),
        (uint8_t)(angle_01deg >> 24), (uint8_t)(angle_01deg >> 16),
        (uint8_t)(angle_01deg >> 8),  (uint8_t)(angle_01deg),
        mode, snF, 0x6B
    };
    emmv5_send_frame(cmd, sizeof(cmd));
}

/* ========================================================================
 *  电机回复帧解析 (轮询, 无需接收中断)
 *
 *  控制命令回复均为 4 字节短帧: [Addr][Func][返回数据][0x6B]
 *   - 02: 命令正确   - 9F: 动作完成(到位/回零, 需控制命令应答≥Reached)
 *   - E2: 参数错误(含堵转/过热保护)   - EE: 格式错误
 * ======================================================================== */

#define EMMV5_RX_FRAME_MAX  16

/* 位置合理性上限: ±8 圈 (毫度). 读取位置超出该范围 (如误拼的错误帧) 判为无效 */
#define EMMV5_POS_MAX_MDEG  (8LL * 360000LL)

typedef struct {
    uint8_t  state;              /* 0=等帧头, 1=收帧中 */
    uint8_t  buf[EMMV5_RX_FRAME_MAX];
    uint8_t  idx;
    uint8_t  expect_len;         /* >0=已知长度的读取回复帧 (按长度收, 忽略帧内0x6B) */
    volatile bool ack_ok;        /* 收到 02 */
    volatile bool reached;       /* 收到 9F */
    volatile bool fault;         /* 收到 E2/EE */
    volatile bool position_valid;  /* 收到 0x36 位置回复 */
    int32_t  position_mdeg;        /* 解析出的电机实时位置 (毫度) */
    emmv5_fw_t fw;                 /* 固件类型 (决定位置/速度换算) */
    uint16_t frame_cnt;          /* 已解析完整帧计数 (调试用) */
    uint8_t  last_frame[EMMV5_RX_FRAME_MAX];  /* 最近一帧完整回复 (调试用) */
    uint8_t  last_frame_len;     /* 最近一帧长度 */
} emmv5_rx_t;

static emmv5_rx_t g_emmv5_rx;

static EMMV5_RX_FrameCb g_rx_frame_cb = NULL;  /* 逐帧回调 (调试/日志) */

void EMMV5_RX_SetFrameCallback(EMMV5_RX_FrameCb cb)
{
    g_rx_frame_cb = cb;
}

void EMMV5_RX_Reset(void)
{
    g_emmv5_rx.state       = 0;
    g_emmv5_rx.idx         = 0;
    g_emmv5_rx.expect_len  = 0;
    g_emmv5_rx.ack_ok      = false;
    g_emmv5_rx.reached     = false;
    g_emmv5_rx.fault       = false;
    g_emmv5_rx.position_valid = false;

    /* 冲空残留 RX 字节, 避免陈旧数据干扰 */
    while (!DL_UART_Main_isRXFIFOEmpty(UART_1_INST)) {
        (void)DL_UART_Main_receiveData(UART_1_INST);
    }
}

void EMMV5_SetFirmware(emmv5_fw_t fw)
{
    g_emmv5_rx.fw = fw;
}

void EMMV5_ReadPosition(uint8_t addr)
{
    /* 5.5.13 读取电机实时位置: 回复 [Addr][0x36][符号][位置(4B大端)][0x6B] */
    uint8_t cmd[3] = { addr, 0x36, 0x6B };
    g_emmv5_rx.position_valid = false;
    emmv5_send_frame(cmd, sizeof(cmd));
}

void EMMV5_RX_Poll(void)
{
    while (!DL_UART_Main_isRXFIFOEmpty(UART_1_INST)) {
        uint8_t ch = (uint8_t)DL_UART_Main_receiveData(UART_1_INST);

        if (g_emmv5_rx.state == 0) {
            /* 等帧头: 帧以电机地址开始 */
            if (ch == EMMV5_DEFAULT_ADDR) {
                g_emmv5_rx.buf[0]     = ch;
                g_emmv5_rx.idx        = 1;
                g_emmv5_rx.expect_len = 0;
                g_emmv5_rx.state      = 1;
            }
            continue;
        }

        if (g_emmv5_rx.idx < EMMV5_RX_FRAME_MAX) {
            g_emmv5_rx.buf[g_emmv5_rx.idx++] = ch;
        }

        /* 第2字节 = 功能码: 已知长度的读取回复按长度收帧. 读取数据帧内可能含
         * 0x6B, 不能按 0x6B 断帧; 控制命令回复固定为 4 字节短帧, 仍按 0x6B 终止. */
        if (g_emmv5_rx.idx == 2) {
            switch (ch) {
            case 0x36: g_emmv5_rx.expect_len = 8; break;  /* 实时位置 (5.5.13) */
            case 0x31: g_emmv5_rx.expect_len = 5; break;  /* 线性化编码器值 (5.5.7) */
            case 0x3A: g_emmv5_rx.expect_len = 5; break;  /* 电机状态标志 (5.5.15) */
            case 0x3B: g_emmv5_rx.expect_len = 5; break;  /* 回零状态标志 (5.4.4) */
            default:   g_emmv5_rx.expect_len = 0; break;
            }
        }

        bool complete = false;
        if (g_emmv5_rx.expect_len > 0U) {
            /* 固定长度读取帧: 收满即停, 末字节必须是校验 0x6B */
            if (g_emmv5_rx.idx == g_emmv5_rx.expect_len && ch == 0x6B) {
                complete = true;
            }
        } else if (ch == 0x6B && g_emmv5_rx.idx >= 3) {
            complete = true;
        }

        if (complete) {
            /* 完整帧: buf[0]=addr, buf[1]=func, buf[2..]=数据, 末字节=0x6B */
            g_emmv5_rx.frame_cnt++;
            g_emmv5_rx.last_frame_len = g_emmv5_rx.idx;
            for (uint8_t i = 0; i < g_emmv5_rx.idx; i++) {
                g_emmv5_rx.last_frame[i] = g_emmv5_rx.buf[i];
            }
            if (g_rx_frame_cb != NULL) {
                g_rx_frame_cb(g_emmv5_rx.buf, g_emmv5_rx.idx);
            }

            /* 位置读取回复解析 (5.5.13):
             *   [Addr][0x36][符号][位置(4字节大端)][0x6B]
             *   符号: 00=正, 01=负 */
            if (g_emmv5_rx.buf[1] == 0x36 && g_emmv5_rx.idx == 8) {
                bool    neg = (g_emmv5_rx.buf[2] != 0x00);
                int64_t raw = ((int64_t)g_emmv5_rx.buf[3] << 24)
                            | ((int64_t)g_emmv5_rx.buf[4] << 16)
                            | ((int64_t)g_emmv5_rx.buf[5] << 8)
                            |  (int64_t)g_emmv5_rx.buf[6];
                int64_t mdeg;
                if (g_emmv5_rx.fw == EMMV5_FW_X) {
                    mdeg = raw * 100;                     /* X: 0.1° → 毫度 */
                } else {
                    mdeg = (raw * 360000LL) / 65536LL;    /* Emm: 0-65535 一圈 */
                }
                if (neg) mdeg = -mdeg;
                /* 合理性检查: 上电静止位置应在有限圈数内 (如 ±8 圈);
                 * 超出 (如误拼的帧) 判为无效, 避免把垃圾值当位置. */
                if (mdeg >= -EMMV5_POS_MAX_MDEG && mdeg <= EMMV5_POS_MAX_MDEG) {
                    g_emmv5_rx.position_mdeg  = (int32_t)mdeg;
                    g_emmv5_rx.position_valid = true;
                }
            }

            /* 仅把已知命令的回复当作状态。像 01 00 EE 6B 这样的
             * 错位/格式错误帧不能锁存电机堵转故障，否则会把后续所有
             * 位置命令都屏蔽，表现为“上电但电机无力/不动”。 */
            bool known_reply =
                (g_emmv5_rx.buf[1] == 0xF3) || /* enable */
                (g_emmv5_rx.buf[1] == 0xFD) || /* Emm position */
                (g_emmv5_rx.buf[1] == 0xF6) || /* velocity */
                (g_emmv5_rx.buf[1] == 0xFE) || /* stop */
                (g_emmv5_rx.buf[1] == 0x0E) || /* clear clog */
                (g_emmv5_rx.buf[1] == 0x0A) || /* clear position */
                (g_emmv5_rx.buf[1] == 0x36);   /* read position */
            if (known_reply) {
                switch (g_emmv5_rx.buf[2]) {
                case 0x02: g_emmv5_rx.ack_ok  = true; break;
                case 0x9F: g_emmv5_rx.reached = true; break;
                case 0xE2:
                case 0xEE: g_emmv5_rx.fault   = true; break;
                default:   break;
                }
            }
            g_emmv5_rx.state = 0;
            g_emmv5_rx.idx   = 0;
        } else if (g_emmv5_rx.idx >= EMMV5_RX_FRAME_MAX
                   || (g_emmv5_rx.expect_len > 0U
                       && g_emmv5_rx.idx >= g_emmv5_rx.expect_len)) {
            /* 超长帧 / 固定长度帧没收满校验: 丢弃重同步 */
            g_emmv5_rx.state = 0;
            g_emmv5_rx.idx   = 0;
        }
    }
}

void EMMV5_RX_GetFlags(bool *reached, bool *fault)
{
    if (reached != NULL) {
        *reached     = g_emmv5_rx.reached;
        g_emmv5_rx.reached = false;
    }
    if (fault != NULL) {
        *fault     = g_emmv5_rx.fault;
        g_emmv5_rx.fault   = false;
    }
    g_emmv5_rx.ack_ok = false;
}

bool EMMV5_RX_GetPosition(int32_t *pos_mdeg)
{
    if (!g_emmv5_rx.position_valid) {
        return false;
    }
    if (pos_mdeg != NULL) {
        *pos_mdeg = g_emmv5_rx.position_mdeg;
    }
    g_emmv5_rx.position_valid = false;
    return true;
}

void EMMV5_RX_GetLastFrame(uint8_t *buf, uint8_t *len)
{
    if (buf != NULL) {
        for (uint8_t i = 0; i < g_emmv5_rx.last_frame_len; i++) {
            buf[i] = g_emmv5_rx.last_frame[i];
        }
    }
    if (len != NULL) {
        *len = g_emmv5_rx.last_frame_len;
    }
}

uint16_t EMMV5_RX_GetFrameCount(void)
{
    return g_emmv5_rx.frame_cnt;
}
