import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import "./globals.css";

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Codex Lumo — 会呼吸的任务悬浮窗",
  description: "一个原创的科幻 Codex 宠物悬浮窗概念，用宠物动作展示实时任务状态。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={geistMono.variable}>{children}</body>
    </html>
  );
}
