---
title: "TS-0003 · 以太网插线后仍无 IP"
description: "从编译时 DHCP 选项、PHY 链路和 netif 状态定位 STM32 以太网不可达的层级。"
type: "troubleshooting"
id: "TS-0003-ethernet-link-without-ip"
tags: ["lwip","ethernet","dhcp"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
ts_id: "TS-0003"
severity: "medium"
related_projects: ["iwip"]
phases: ["地址配置", "RMII 时钟与 PHY", "DMA 收包", "netif 状态", "协议应答"]
root_cause: "默认 LWIP_DHCP=0，使用静态 192.168.1.30/24。地址匹配后，PHY 协商、MAC 启动或 RX 缓冲落入 CCM 等故障仍会让已亮灯的端口无法收包。"
located_by: "先用 [NET] Mode 确认地址模式，再查 PA1、MDIO 和 netif 链路标志，并对照 ETH RX IRQ、线程唤醒及 DHCP/ARP/ICMP 抓包找到首个失败环节。"
---

## 典型现象与触发条件

交换机与 PHY 指示灯显示已接线，开发板却无租约、无 ARP 回复或 ping 不通。默认静态固件使用 `192.168.1.30/24`，接入的测试 PC 需使用同网段未占用地址。只有实际编入 DHCP 路径时才预期出现租约申请。

| 初始记录 | 需要的证据 |
| --- | --- |
| 固件和模式 | SHA、Keil 目标、`LWIP_DHCP`、`[NET] Mode:` 日志 |
| 物理链路 | 开发板、交换机端口、线缆和 PA1 时钟 |
| 测试网络 | PC 网卡、IP/掩码、VLAN、是否有 DHCP 服务器 |
| 快照变量 | MDIO 地址、PHY 协商结果、`g_lwipdev`、`g_lwip_netif` |
| 包级证据 | 同一时间窗口的 ARP、ICMP 和可选 DHCP 抓包 |

## 错误原因与触发机理

固定提交支持以下分支。以实际固件的模式、地址和收包证据判定当前是哪一支。

- **等不到租约。** `LWIP_DHCP` 默认是 `0`，`lwip_comm_init` 直接将静态 IPv4 地址设置为 `192.168.1.30/24`。在这套固件上等待 DHCP Discover 会一直没有结果。测试 PC 地址在另一个网段或 VLAN 时，也可能无法发起有效的同链路 ARP。
- **物理有链路，协议栈还未就绪。** `eth_link` 每 100 ms 检查一次 PHY。LAN8720A 的 BSR 链路位低电平锁存，驱动连读两次，再通过 PHYSCSR 取得协商后的速率与双工。MAC 成功设置并运行 `HAL_ETH_Start_IT` 后才调用 `netif_set_link_up`。
- **PHY 与 MAC 已启动，DMA 收不到数据。** DMA 描述符和 RX 缓冲要位于 ETH DMA 可访问的 SRAM。若链接布局把它们放入 F407 从 `0x10000000` 开始的 CCM RAM，PHY 仍能亮灯，DMA 却无法访问这些地址。查最终 map 才能确认是否发生了这种放置错误。[DMA 描述符分配](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Drivers/BSP/ETHERNET/ethernet.c)

## 定位过程与关键证据

1. 读取串口 `[NET] Mode:`。静态固件对照实际 IP、掩码和主机网段；DHCP 固件对照租约或超时回退日志。先用模式确定该等待什么流量。
2. 测 PA1 是否有稳定的 50 MHz RMII 时钟。用 MDIO 检查 ID1/ID2 和 BSR 双读结果，再看 PHYSCSR 协商完成和双工。通过后读取 `g_lwip_netif` 的 `link_up` 标志；PHY 正常且该位未置时，沿 `ethernetif_link_check_state` 检查 MAC 配置和启动返回值。
3. 链路已置位后，用同网段 PC 的 ARP 请求或同一轮 DHCP 租约回复作为已知输入。按 ETH RX IRQ → `HAL_ETH_RxCpltCallback` 释放 `s_rx_semaphore` → `eth_thread` 醒来 → `HAL_ETH_ReadData` → `netif->input` 逐点记录。第一个缺失处对应中断、描述符/缓冲、线程调度或输入交接问题。结合描述符地址、OWN 位与 RX 池状态验证。
4. 收包进入栈后，分别核对 `netif_is_up`、`netif_is_link_up` 和实际 IPv4 地址。DHCP 模式追踪租约交换或静态回退；地址确定后，按 ARP 请求/应答、ICMP 请求/应答依次确认。固定源码给出了这些判据，具体丢包点以同轮抓包为准。

## 具体排查流程

### 故障定位决策树

```mermaid
flowchart TD
    A{"实际编译的 LWIP_DHCP"}
    A -->|0| S["确认静态 IP 与同网段测试主机"]
    A -->|1| T["确认租约环境与状态日志"]
    S --> P{"RMII 时钟、PHY 协商和 MAC 启动通过"}
    T --> P
    P -->|否| H["测 PA1，读 PHY 寄存器和 MAC 启动结果"]
    P -->|是| M{"RX 描述符与输入线程有活动"}
    M -->|否| R["检查 ETH 启动、DMA 内存、IRQ 与信号量"]
    M -->|是| N{"netif 的 link、up 和地址符合预期"}
    N -->|否| L["检查链路回调、DHCP 或静态回退"]
    N -->|是| C["按 DHCP、ARP、ICMP 和应用协议观察响应"]
```

### 分步排查与速查表

| 阶段 | 观测点与日志 | 正常基线 | 异常根因 | 处理 |
| --- | --- | --- | --- | --- |
| 地址配置 | `LWIP_DHCP`、`[NET] Mode: Static` 或 `[NET] Mode: DHCP` | 默认 0，IP `192.168.1.30`、掩码 `255.255.255.0`、网关 `192.168.1.1` | 固件模式或主机网段不符 | 对照 Keil 宏与开机日志 |
| RMII 时钟与 PHY · 启动 | `[ETH] lwIP(FreeRTOS) init ok`、`g_lwip_init_status` | 初始化可在未插线时成功 | PHY 初始化失败或分配失败 | 对照 `lwip_comm_init failed` 及重试 |
| RMII 时钟与 PHY · 时钟 | PA1 50 MHz、PHY nRST、MDC/MDIO | PHY 输出 RMII REFCLKO，稳定复位释放 | 时钟方向错误、复位未释放 | 用示波器测 PA1 |
| RMII 时钟与 PHY · 协商 | ID1 `0x0007`，ID2 mask `0xFFF0` 得 `0xC0F0` | BSR 地址 `0x01` 的 link 位有效，PHYSCSR 地址 `0x1F` 有协商结果 | MDIO 地址、连线、协商或 MAC 启动失败 | 核对协商、`HAL_ETH_Start_IT` 和 link 标志 |
| DMA 收包 | `HAL_ETH_ReadData`、ISR、`eth_thread` 和描述符 OWN | IRQ 唤醒 RX 线程；pbuf 消费完后归还 RX 池 | DMA 地址进 CCM、池耗尽、未收到中断 | 检查 map，在 ISR、信号量和 pbuf 分配/回收处记计数 |
| netif 状态 | `netif_is_link_up` / `netif_is_up` / IPv4 | link 与 up 各有标志，IPv4 为静态配置或租约 | 网卡管理状态或地址未更新 | 对照 `netif_set_up`、link 回调和地址状态机 |
| 协议应答 · DHCP | `[NET] DHCP IP:` 或 `[NET] DHCP timeout, static IP:` | 模式开启时申请；`tries>4` 走静态回退 | 服务器、广播隔离、包未送栈 | 判断四步交换中断位置，用实际地址复测 |
| 协议应答 · ARP/ICMP | ARP Request/Reply，再看 Echo | 邻居缓存无条目时先解析 MAC，后有 Echo Reply | 地址冲突、回包路径、主机防火墙 | 对照两端抓包及 PC 邻居缓存 |
| 协议应答 · 服务 | 实际业务端口、Netconn 编译选项 | 有监听者后才有应用响应 | 地址已通但服务未启用 | 用服务端日志和 TCP 连接对照 |

当前源码里 `LWIP_STATS=0`。统计 RX 时用调试器或临时插桩区分中断、`ReadData` 成功、`netif->input` 错误和池释放，自定义调试计数与 lwIP 原生统计分开记录。

## 关键源码测点

- [编译配置](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/lwipopts.h)确认 OS 模式、DHCP 和校验开关。
- [PHY 识别与链路](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Drivers/BSP/ETHERNET/ethernet_chip.c)查看 MDIO 扫描、BCR reset、BSR 读取和 PHYSCSR 速率双工。
- [输入和链路状态](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/ethernetif.c)查看 `ethernetif_link_check_state`、`ethernetif_input` 与 `pbuf_free_custom`。
- [地址状态机](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/lwip_comm.c)查看 `lwip_link_status_updated`、`lwip_dhcp_process`、`g_lwipdev` 和 `g_lwip_netif`。
- [网络启动与应用并行](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/application/app_task.c)查看 `start_task` 的多次尝试及触摸任务是否仍运行。

## 验证闭环与边界

| 抓包顺序 | 过滤方式 | 应看到的现象 |
| --- | --- | --- |
| DHCP 模式先确认租约 | `udp.port == 67 or udp.port == 68` | Discover、Offer、Request、ACK；无租约时对照超时回退 |
| IP 已确定后看 ARP | `arp` | PC 求指定 IP，目标以对应 MAC 回答 |
| 邻居解析后看 ICMP | `icmp and ip.addr == 192.168.1.30`，替换为实际 IP | Echo Request/Reply，结果与发起主机一致 |
| 存在业务服务时看端口 | `tcp.port == 端口号`，代入数值 | 连接握手和服务响应各自明确 |

链路刚恢复时先确认 PHY 返回 10/100 Mbit/s 与预期双工，再核对 MAC 配置。BSR 的链路状态需要按驱动的读取方式解释，协商未完成先等待下一个 100 ms 链路检查。

在 PC 侧记录 `Get-NetNeighbor -AddressFamily IPv4` 和 `ping` 结果。若交换机隔离流量，按需要从能看到广播和目标单播的位置抓包。插拔线缆复测链路、地址与恢复后首次应答，并在触摸并发负载下复测。

> [!WARNING]
> 需实板/仪器验证边界。link LED 亮只提供物理线索，完整连通性按 PHY、DMA、接口、地址和协议响应逐层证实。

通过标准为同一测试轮中记录成功的 ARP 和 ICMP，DHCP 固件另需解释租约或回退后的地址来源。

对照 [[ethernet-link-and-ip|以太网分层模型]] 与 [[ADR-0003-run-lwip-in-rtos-mode|lwIP OS 模式决策]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
