/**
  ******************************************************************************
  * @file    LwIP/LwIP_TCP_Echo_Client/Inc/lwipopts.h
  * @author  MCD Application Team
  * @brief   lwIP Options Configuration.
  ******************************************************************************
  * @attention
  *
  * Copyright (c) 2017 STMicroelectronics.
  * All rights reserved.
  *
  * This software is licensed under terms that can be found in the LICENSE file
  * in the root directory of this software component.
  * If no LICENSE file comes with this software, it is provided AS-IS.
  *
  ******************************************************************************
  */
#ifndef __LWIPOPTS_H__
#define __LWIPOPTS_H__

/**
 * NO_SYS==0: 使用 FreeRTOS 操作系统模式（启用 tcpip_thread、信号量/邮箱与 Netconn API）。
 */
#define NO_SYS                  0
#define LWIP_SUPPORT_CUSTOM_PBUF 1
#define LWIP_IPV4               1
#define LWIP_IPV6               0

/**
 * SYS_LIGHTWEIGHT_PROT==1: 开启跨任务与中断临界区保护（pbuf/mem 分配与释放）。
 */
#define SYS_LIGHTWEIGHT_PROT    1

/* ---------- Memory options ---------- */
/* MEM_ALIGNMENT: should be set to the alignment of the CPU for which
   lwIP is compiled. 4 byte alignment -> define MEM_ALIGNMENT to 4, 2
   byte alignment -> define MEM_ALIGNMENT to 2. */
#define MEM_ALIGNMENT           4

/* MEM_SIZE: the size of the heap memory. 适配 F407 128KB 主 SRAM 预算。 */
#define MEM_SIZE                (16*1024)

/* MEMP_NUM_PBUF: the number of memp struct pbufs. If the application
   sends a lot of data out of ROM (or other static memory), this
   should be set high. */
#define MEMP_NUM_PBUF           10
/* MEMP_NUM_UDP_PCB: the number of UDP protocol control blocks. One
   per active UDP "connection". */
#define MEMP_NUM_UDP_PCB        6
/* MEMP_NUM_TCP_PCB: the number of simulatenously active TCP
   connections. */
#define MEMP_NUM_TCP_PCB        10
/* MEMP_NUM_TCP_PCB_LISTEN: the number of listening TCP
   connections. */
#define MEMP_NUM_TCP_PCB_LISTEN 5
/* MEMP_NUM_TCP_SEG: the number of simultaneously queued TCP
   segments. */
#define MEMP_NUM_TCP_SEG        8
/* MEMP_NUM_SYS_TIMEOUT: the number of simulateously active
   timeouts. */
#define MEMP_NUM_SYS_TIMEOUT    10
#define MEMP_NUM_NETBUF         8
#define MEMP_NUM_NETCONN        6
#define MEMP_NUM_TCPIP_MSG_API  8
#define MEMP_NUM_TCPIP_MSG_INPKT 8


/* ---------- Pbuf options ---------- */
/* PBUF_POOL_SIZE: the number of buffers in the pbuf pool. */
#define PBUF_POOL_SIZE          8

/* PBUF_POOL_BUFSIZE: the size of each pbuf in the pbuf pool. */
#define PBUF_POOL_BUFSIZE       1524

/* ---------- TCP options ---------- */
#define LWIP_TCP                1
#define TCP_TTL                 255

/* Controls if TCP should queue segments that arrive out of
   order. Define to 0 if your device is low on memory. */
#define TCP_QUEUE_OOSEQ         0

/* TCP Maximum segment size. */
#define TCP_MSS                 (1500 - 40)	  /* TCP_MSS = (Ethernet MTU - IP header size - TCP header size) */

/* TCP sender buffer space (bytes). */
#define TCP_SND_BUF             (4*TCP_MSS)

/*  TCP_SND_QUEUELEN: TCP sender buffer space (pbufs). This must be at least
  as much as (2 * TCP_SND_BUF/TCP_MSS) for things to work. */

#define TCP_SND_QUEUELEN        (2* TCP_SND_BUF/TCP_MSS)

/* TCP receive window. */
#define TCP_WND                 (2*TCP_MSS)


/* ---------- ICMP options ---------- */
#define LWIP_ICMP                       1


/* ---------- DHCP options ---------- */
#ifndef LWIP_DHCP
#define LWIP_DHCP               0
#endif


/* ---------- UDP options ---------- */
#define LWIP_UDP                1
#define UDP_TTL                 255


/* ---------- Statistics options ---------- */
#define LWIP_STATS 0

/* ---------- link callback options ---------- */
/* LWIP_NETIF_LINK_CALLBACK==1: Support a callback function from an interface
 * whenever the link changes (i.e., link down)
 */
#define LWIP_NETIF_LINK_CALLBACK        1

/*
   --------------------------------------
   ---------- Checksum options ----------
   --------------------------------------
*/

/* 全硬件完成 IP、UDP、TCP、ICMP 校验（配合 MAC ChecksumOffload 与 TX 描述符 CIC）。 */
#define CHECKSUM_GEN_IP                 0
#define CHECKSUM_GEN_UDP                0
#define CHECKSUM_GEN_TCP                0
#define CHECKSUM_GEN_ICMP               0
#define CHECKSUM_CHECK_IP               0
#define CHECKSUM_CHECK_UDP              0
#define CHECKSUM_CHECK_TCP              0
#define CHECKSUM_CHECK_ICMP             0



/*
   ----------------------------------------------
   ---------- Sequential layer options ----------
   ----------------------------------------------
*/
/**
 * LWIP_NETCONN==1: Enable Netconn API (require to use api_lib.c)
 */
#define LWIP_NETCONN                    1

/*
   ------------------------------------
   ---------- Socket options ----------
   ------------------------------------
*/
/**
 * LWIP_SOCKET==1: Enable Socket API (require to use sockets.c)
 */
#ifndef LWIP_SOCKET
#define LWIP_SOCKET                     0
#endif

/*
   ---------------------------------
   ---------- OS options ----------
   ---------------------------------
*/
#define TCPIP_THREAD_NAME               "TCP/IP"
#define TCPIP_THREAD_STACKSIZE          1024
#define TCPIP_MBOX_SIZE                 8
#define DEFAULT_UDP_RECVMBOX_SIZE       6
#define DEFAULT_TCP_RECVMBOX_SIZE       6
#define DEFAULT_ACCEPTMBOX_SIZE         6
#define DEFAULT_RAW_RECVMBOX_SIZE       6
#define DEFAULT_THREAD_STACKSIZE        512
#define TCPIP_THREAD_PRIO               5

#define LWIP_PROVIDE_ERRNO              1

#endif /* __LWIPOPTS_H__ */
