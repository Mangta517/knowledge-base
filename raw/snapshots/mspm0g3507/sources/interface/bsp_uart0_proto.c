/**
 * @file    bsp_uart0_proto.c
 * @brief   K230视觉模块 UART0 双向协议实现 (参考项目v2移植)
 *
 * 接收K230 UART2 → MSPM0 UART0 的 ASCII 协议帧.
 * 发送PID调参命令到K230.
 *
 * 硬件: UART0 (PA10=TX, PA11=RX), 115200 8N1
 */

#include "bsp_uart0_proto.h"
#include "ti_msp_dl_config.h"
#include <string.h>
#include <stdlib.h>
#include <stdio.h>

/* 适配当前项目: UART0 (PA10=TX, PA11=RX) 接 K230 */
#define UART0_PROTO_INST  UART_0_INST

#ifndef CPUCLK_FREQ
#define CPUCLK_FREQ  80000000UL
#endif

/* ========================================================================
 *  全局数据
 * ======================================================================== */

uart0_proto_data_t g_uart0_data;

#define UART0_RX_RING_SIZE  128U
#define UART0_RX_RING_MASK  (UART0_RX_RING_SIZE - 1U)
#define UART0_CX_MAX        799L
#define UART0_CY_MAX        479L
#define UART0_ANGLE_MAX     90000L

static uint8_t g_uart0_rx_ring[UART0_RX_RING_SIZE];
static volatile uint16_t g_uart0_rx_head;
static volatile uint16_t g_uart0_rx_tail;
static volatile bool g_uart0_rx_reset_pending;

volatile uint32_t g_uart0_rx_overflow_count;
volatile uint32_t g_uart0_hw_error_count;
volatile uint32_t g_uart0_parse_error_count;

/* ========================================================================
 *  帧解析状态机
 * ======================================================================== */

typedef enum {
    RX_IDLE = 0,
    RX_RECV,
} rx_state_t;

static rx_state_t g_rx_state = RX_IDLE;
static uint8_t    g_rx_buf[UART0_PROTO_RX_BUF_SIZE];
static uint8_t    g_rx_idx = 0;

/* ========================================================================
 *  UART0_Proto_Init — 初始化 UART0 硬件 (中断收字节, 主循环解析)
 * ======================================================================== */

void UART0_Proto_Init(void)
{
    /*
     * 假设 SysConfig (SYSCFG_DL_init) 已完成 UART0 全部基础配置:
     *   - 引脚: PA10=TX, PA11=RX
     *   - 波特率: 115200, 8N1
     *   - 时钟, 电源, FIFO
     *
     * 我们只做: 冲空FIFO, 开启RX中断, 初始化协议状态机.
     * 不要重新 disable/enable UART0 — 会破坏 SysConfig 的配置!
     */

    /* 冲空 RX FIFO */
    while (!DL_UART_Main_isRXFIFOEmpty(UART0_PROTO_INST)) {
        (void)DL_UART_Main_receiveData(UART0_PROTO_INST);
    }

    /* 先清理中断状态，再只开启 RX 与硬件错误中断。 */
    DL_UART_Main_disableInterrupt(UART0_PROTO_INST,
        DL_UART_MAIN_INTERRUPT_RX |
        DL_UART_MAIN_INTERRUPT_TX |
        DL_UART_MAIN_INTERRUPT_OVERRUN_ERROR |
        DL_UART_MAIN_INTERRUPT_BREAK_ERROR |
        DL_UART_MAIN_INTERRUPT_PARITY_ERROR |
        DL_UART_MAIN_INTERRUPT_FRAMING_ERROR);
    DL_UART_Main_clearInterruptStatus(UART0_PROTO_INST,
        DL_UART_MAIN_INTERRUPT_RX |
        DL_UART_MAIN_INTERRUPT_TX |
        DL_UART_MAIN_INTERRUPT_OVERRUN_ERROR |
        DL_UART_MAIN_INTERRUPT_BREAK_ERROR |
        DL_UART_MAIN_INTERRUPT_PARITY_ERROR |
        DL_UART_MAIN_INTERRUPT_FRAMING_ERROR);

    /* ── 初始化协议状态机 ── */
    memset(&g_uart0_data, 0, sizeof(g_uart0_data));
    g_uart0_data.cx         = -1;
    g_uart0_data.cy         = -1;
    g_uart0_data.angle_mdeg = 0;
    g_uart0_data.valid      = false;
    g_uart0_data.fresh      = false;

    g_rx_state = RX_IDLE;
    g_rx_idx   = 0;
    g_uart0_rx_head = 0;
    g_uart0_rx_tail = 0;
    g_uart0_rx_reset_pending = false;
    g_uart0_rx_overflow_count = 0;
    g_uart0_hw_error_count = 0;
    g_uart0_parse_error_count = 0;

    DL_UART_Main_enableInterrupt(UART0_PROTO_INST,
        DL_UART_MAIN_INTERRUPT_RX |
        DL_UART_MAIN_INTERRUPT_OVERRUN_ERROR |
        DL_UART_MAIN_INTERRUPT_BREAK_ERROR |
        DL_UART_MAIN_INTERRUPT_PARITY_ERROR |
        DL_UART_MAIN_INTERRUPT_FRAMING_ERROR);
    NVIC_SetPriority(UART_0_INST_INT_IRQN, 1U);
    NVIC_ClearPendingIRQ(UART_0_INST_INT_IRQN);
    NVIC_EnableIRQ(UART_0_INST_INT_IRQN);
}

/* ========================================================================
 *  UART0 RX ISR — 只搬运字节，解析留给主循环
 * ======================================================================== */

void UART0_Proto_RX_IRQHandler(void)
{
    const uint32_t error_mask =
        DL_UART_MAIN_INTERRUPT_OVERRUN_ERROR |
        DL_UART_MAIN_INTERRUPT_BREAK_ERROR |
        DL_UART_MAIN_INTERRUPT_PARITY_ERROR |
        DL_UART_MAIN_INTERRUPT_FRAMING_ERROR;
    const uint32_t interrupt_mask = DL_UART_MAIN_INTERRUPT_RX | error_mask;
    uint32_t status = DL_UART_Main_getRawInterruptStatus(
        UART0_PROTO_INST, interrupt_mask);

    DL_UART_Main_clearInterruptStatus(
        UART0_PROTO_INST, status & interrupt_mask);

    if ((status & error_mask) != 0U) {
        g_uart0_hw_error_count++;
        g_uart0_rx_reset_pending = true;
    }

    while (!DL_UART_Main_isRXFIFOEmpty(UART0_PROTO_INST)) {
        uint8_t ch = (uint8_t)DL_UART_Main_receiveData(UART0_PROTO_INST);
        uint16_t next = (uint16_t)((g_uart0_rx_head + 1U) & UART0_RX_RING_MASK);

        if (next == g_uart0_rx_tail) {
            g_uart0_rx_overflow_count++;
            g_uart0_rx_reset_pending = true;
        } else {
            g_uart0_rx_ring[g_uart0_rx_head] = ch;
            g_uart0_rx_head = next;
        }
    }
}

static bool uart0_parse_frame(void)
{
    char *start = (char *)g_rx_buf;
    char *end;
    long cx = strtol(start, &end, 10);
    if (end == start || *end != ',') {
        return false;
    }

    start = end + 1;
    long cy = strtol(start, &end, 10);
    if (end == start) {
        return false;
    }

    long angle = 0;
    if (*end == ',') {
        start = end + 1;
        angle = strtol(start, &end, 10);
        if (end == start || *end != '\0'
            || angle < -UART0_ANGLE_MAX || angle > UART0_ANGLE_MAX) {
            return false;
        }
    } else if (*end != '\0') {
        return false;
    }

    bool no_ball = (cx == -1L && cy == -1L);
    bool in_range = (cx >= 0L && cx <= UART0_CX_MAX
                     && cy >= 0L && cy <= UART0_CY_MAX);
    if (!no_ball && !in_range) {
        return false;
    }

    memcpy(g_uart0_data.raw, g_rx_buf, g_rx_idx + 1U);
    g_uart0_data.raw_len = g_rx_idx;
    g_uart0_data.cx = (int16_t)cx;
    g_uart0_data.cy = (int16_t)cy;
    g_uart0_data.angle_mdeg = (int32_t)angle;
    g_uart0_data.valid = in_range;
    g_uart0_data.fresh = true;
    return true;
}

static void uart0_process_byte(uint8_t ch)
{
    switch (g_rx_state) {
    case RX_IDLE:
        if (ch == UART0_PROTO_FRAME_START) {
            g_rx_idx = 0;
            g_rx_state = RX_RECV;
        }
        break;

    case RX_RECV:
        if (ch == UART0_PROTO_FRAME_END) {
            g_rx_buf[g_rx_idx] = '\0';
            if (!uart0_parse_frame()) {
                g_uart0_parse_error_count++;
            }
            g_rx_state = RX_IDLE;
            g_rx_idx = 0;
        } else if (ch == UART0_PROTO_FRAME_START) {
            g_rx_idx = 0;
        } else if (g_rx_idx < UART0_PROTO_RX_BUF_SIZE - 1U) {
            g_rx_buf[g_rx_idx++] = ch;
        } else {
            g_uart0_parse_error_count++;
            g_rx_state = RX_IDLE;
            g_rx_idx = 0;
        }
        break;

    default:
        g_rx_state = RX_IDLE;
        g_rx_idx = 0;
        break;
    }
}

/* ========================================================================
 *  UART0_Proto_Poll — 主循环消费中断环形缓冲并解析
 * ======================================================================== */

void UART0_Proto_Poll(void)
{
    if (g_uart0_rx_reset_pending) {
        __disable_irq();
        g_uart0_rx_tail = g_uart0_rx_head;
        g_uart0_rx_reset_pending = false;
        __enable_irq();
        g_rx_state = RX_IDLE;
        g_rx_idx = 0;
    }

    while (g_uart0_rx_tail != g_uart0_rx_head) {
        uint8_t ch = g_uart0_rx_ring[g_uart0_rx_tail];
        g_uart0_rx_tail = (uint16_t)((g_uart0_rx_tail + 1U) & UART0_RX_RING_MASK);
        uart0_process_byte(ch);
        if (g_uart0_rx_reset_pending) {
            break;
        }
    }
}

const char* UART0_Proto_GetLastFrame(void)
{
    g_uart0_data.raw[g_uart0_data.raw_len] = '\0';
    return (const char *)g_uart0_data.raw;
}

/* ========================================================================
 *  基础发送 API
 * ======================================================================== */

void UART0_Proto_SendByte(uint8_t byte)
{
    DL_UART_Main_transmitDataBlocking(UART0_PROTO_INST, byte);
}

void UART0_Proto_SendString(const char *s)
{
    while (*s != '\0') {
        UART0_Proto_SendByte((uint8_t)*s++);
    }
}

void UART0_Proto_SendTask(uint8_t task_id)
{
    UART0_Proto_SendByte(0xFF);
    UART0_Proto_SendByte(task_id);
    UART0_Proto_SendByte(0x0D);
}

/* ========================================================================
 *  PID 调参命令发送 (MSPM0 → K230)
 *
 *  协议: "!<CMD>[,<ARG>]#"
 *    !SET,KP,20.0#   !SET,KD,30.0#   !SET,KI,0.50#
 *    !TUNE#  !SAVE#  !LOAD#  !STATUS#
 * ======================================================================== */

void UART0_Proto_SendPID_Set(const char *param, float val)
{
    char buf[32];
    int len;

    if (val == (int)val) {
        len = snprintf(buf, sizeof(buf), "!SET,%s,%d#", param, (int)val);
    } else {
        len = snprintf(buf, sizeof(buf), "!SET,%s,%.2f#", param, (double)val);
    }

    if (len > 0 && len < (int)sizeof(buf)) {
        for (int i = 0; i < len; i++) {
            UART0_Proto_SendByte((uint8_t)buf[i]);
        }
    }
}

void UART0_Proto_SendPID_Tune(void)
{
    UART0_Proto_SendString("!TUNE#");
}

void UART0_Proto_SendPID_Save(void)
{
    UART0_Proto_SendString("!SAVE#");
}

void UART0_Proto_SendPID_Load(void)
{
    UART0_Proto_SendString("!LOAD#");
}

void UART0_Proto_SendPID_Status(void)
{
    UART0_Proto_SendString("!STATUS#");
}
