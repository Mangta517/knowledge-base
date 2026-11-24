---
title: "从以太网链路到 IPv4 可达"
description: "按 PHY 协商、MAC/DMA、netif 地址和上层协议顺序验证 MCU 以太网。"
type: "topic"
id: "ethernet-link-and-ip"
tags: ["ethernet","lwip","dhcp"]
created: "2026-11-21"
updated: "2026-11-24"
draft: false
domain: "networking"
related_projects: ["iwip"]
---

## 问题本质与适用边界

插网线后，PHY 可建立物理链路，MAC 仍需接收正确帧，网络栈还要具备地址，应用才有条件接收或响应请求。用四层状态和对应测点定位掉在哪一步。本文以 [[iwip|F407 以太网]] 的 FreeRTOS 与 lwIP OS 模式为实例。

先确定静态或 DHCP 构建。默认静态 `192.168.1.30/24`，网关 `192.168.1.1`。在同一网段进行 ARP 和 ICMP 测试时，让主机与目标 IP 处在同一二层广播域，排除 VLAN 或网桥隔离。

## 核心机制模型

```mermaid
flowchart LR
    H["线缆与交换机"] --> P["PHY：RMII 时钟与 MDIO 协商"]
    P --> M["MAC：速度、双工、DMA 描述符"]
    M --> L["lwIP：netif、ARP、静态地址或 DHCP"]
    L --> A["ICMP、Netconn 或已启用的 Socket"]
    A --> E["应用响应与实际端口"]
    L -->|发送 pbuf| M
``` 

状态沿路径传递，观察要回到驱动边界。`netif_is_up` 表示软件管理状态，`netif_is_link_up` 表示 PHY/MAC 链路路径更新的标志。IPv4 和 DHCP 状态来自地址分配。TCP 应用端口还需要监听或建立连接，具体构建默认 `LWIP_NETCONN=1`、`LWIP_SOCKET=0`。

## 跨项目实现对比

| 参考项目与层级 | 核心文件 | 状态或证据 | 常见故障表现 | 检查方式 |
| --- | --- | --- | --- | --- |
| Iwip · PHY | `Drivers/BSP/ETHERNET/ethernet_chip.c` | BSR 链路、LAN8720A ID 与 PHYSCSR 协商结果 | LED 不亮、速率未确认、MDIO 常读 `0xFFFF` | 示波器量 PA1 50 MHz，读取 0x02/0x03 和 0x1F |
| Iwip · MAC/DMA | `ethernet.c`、`ethernetif.c` | MAC speed/duplex、描述符 OWN、RX 中断/信号量 | 交换机可见链路，收帧计数不增 | 核对描述符在内部 SRAM，分别统计中断、读包、输入错误 |
| Iwip · netif / IPv4 | `lwip_comm.c`、`lwipopts.h` | link/up、地址、ARP、DHCP 与回退 | 没租约、ARP 无回复或使用旧 IP | 对照 `[NET]`、`g_lwipdev` 和两端抓包 |
| Iwip · 协议服务 | lwIP ICMP、Netconn 接口及应用代码 | Echo Reply、连接状态或监听端口 | ARP 通而 ping 不通，或 ping 通但端口未开放 | 按协议抓包，核对实际编译选项与监听者 |
| [[watch|手表]] · 系统对照 | SPI DMA 与蓝牙 UART | 模块就绪、字节发送、手机收到各有计数 | 字节交给模块后，远端仍可丢帧 | 对照发送端计数与接收序号，沿层级收集证据 |

源码参照 [PHY 层](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Drivers/BSP/ETHERNET/ethernet_chip.c)、[MAC 与网络数据交接](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/ethernetif.c)、[地址管理](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/lwip_comm.c)。第五行从另一个项目对照同类观测问题，前四行关注同一个网口的不同层。

## 可复用模式与常见反模式

以下为按事件设置地址策略的伪代码。link callback 记录当前状态，地址配置任务在 lwIP 支持的核心上下文执行。实际 Iwip 地址包含租约、回退和断开状态，在 `lwip_dhcp_process` 内持核心锁推进。核心回调上下文中直接执行时，应按 port 的锁规则调用。

```c
void app_netif_link_changed(struct netif *netif)
{
    publish_link_state(netif_is_link_up(netif));
}

void app_netif_apply_policy(struct netif *netif, uint8_t use_dhcp)
{
    /* 由 tcpip_callback 调用，地址对象由网络初始化提供。 */
    if (!netif_is_link_up(netif))
    {
        dhcp_stop(netif);
        netif_set_addr(netif, &ip_any, &ip_any, &ip_any);
        return;
    }

    if (use_dhcp)
    {
        netif_set_addr(netif, &ip_any, &ip_any, &ip_any);
        if (dhcp_start(netif) != ERR_OK)
        {
            publish_address_error();
        }
    }
    else
    {
        dhcp_stop(netif);
        netif_set_addr(netif, &static_ip, &static_mask, &static_gateway);
    }
}
```

仅在链路边沿或策略切换时调用上述骨架。DHCP 分支需在编译启用后接入，回退由地址状态模块决定。轮询中反复启动 DHCP 会重置申请进度。应用使用 RAW API 时沿 TCP/IP 核心或允许的核心锁路径执行，跨任务共享同一连接还需遵循对应 API 的并发约束。配置参考 [lwipopts.h](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/lwipopts.h) 与 [移植层](https://github.com/Mangta517/Iwip/blob/eb966f2289c240fd18d5b670aea3057d5f73e3f8/Middlewares/Iwip/arch/sys_arch.c)。

| 主机操作 | Wireshark 显示过滤 | 用途 |
| --- | --- | --- |
| `Get-NetIPAddress -AddressFamily IPv4` | `arp` | 确认测试网卡、前缀，并观察谁询问板卡 IP |
| `Get-NetNeighbor -AddressFamily IPv4` 或 `arp -a` | `arp.opcode == 1 or arp.opcode == 2` | 区分请求、回复和过期邻居 |
| `ping -n 4 192.168.1.30` | `icmp && ip.addr == 192.168.1.30` | 独立确认 Echo Request 与 Reply |
| DHCP 构建插拔一次网线 | `udp.port == 67 or udp.port == 68` | 观察 Discover、Offer、Request、ACK |
| 存在 TCP 服务时连接其端口 | `tcp && ip.addr == 192.168.1.30` | 检查握手以及应用是否确实启用 |

## 系统化验证用例

| 场景 | 刺激 | 记录 | 预期 |
| --- | --- | --- | --- |
| 静态地址，链路良好 | 同网段主机访问默认 IP | PHY、MAC、netif、ARP、ICMP | 逐层向上出现对应可观测事件 |
| PHY 链路断开后恢复 | 插拔线缆一次 | 协商、MAC 启停、link flag、恢复后包 | 新链路后重新收发 |
| DHCP 可用 | 编入 DHCP，接支持 DHCP 的测试网段 | 地址状态及四步报文 | 获取租约并用真实地址访问 |
| DHCP 无应答 | 编入 DHCP，隔离服务器 | 请求重试计数、回退日志 | 超过配置门限后使用静态地址 |
| RX 缓冲压力 | 合法测试流量，保留并释放 pbuf 引用 | 池计数、RBUS、输入错误 | 在引用释放后恢复 |
| 与触摸并行 | 收包或回包时连续操作画板 | 触摸响应间隔、线程高水位、RTT | 时间和内存满足产品预算 |

硬件排障顺序见 [[TS-0003-ethernet-link-without-ip|网线已连但 IPv4 不可达]]。系统模式取舍详见 [[ADR-0003-run-lwip-in-rtos-mode|lwIP OS 模式]]。

<!-- HUMAN-NOTES:START -->
## 个人复盘与后续思考
（由人工补充与维护）
<!-- HUMAN-NOTES:END -->
