"use client";

import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useEffect, useRef, useState } from "react";

type PetMode = "working" | "thinking" | "done" | "resting";

const modeDetails: Record<
  PetMode,
  { label: string; eyebrow: string; detail: string; progress: number }
> = {
  working: {
    label: "编码中",
    eyebrow: "ACTIVE TASK",
    detail: "正在连接任务状态与宠物动作",
    progress: 68,
  },
  thinking: {
    label: "思考中",
    eyebrow: "DEEP THINK",
    detail: "正在拆解交互与视觉层级",
    progress: 42,
  },
  done: {
    label: "已完成",
    eyebrow: "MISSION CLEAR",
    detail: "悬浮窗原型已经准备就绪",
    progress: 100,
  },
  resting: {
    label: "待机中",
    eyebrow: "LOW POWER",
    detail: "Lumo 正在等候下一项任务",
    progress: 12,
  },
};

const modeButtons: { id: PetMode; label: string; shortcut: string }[] = [
  { id: "working", label: "编码", shortcut: "1" },
  { id: "thinking", label: "思考", shortcut: "2" },
  { id: "done", label: "完成", shortcut: "3" },
  { id: "resting", label: "休眠", shortcut: "4" },
];

function Pet({ mode, compact = false }: { mode: PetMode; compact?: boolean }) {
  return (
    <div
      className={`pet pet--${mode} ${compact ? "pet--compact" : ""}`}
      role="img"
      aria-label={`Codex 宠物 Lumo，当前${modeDetails[mode].label}`}
    >
      <span className="pet__orbit pet__orbit--one" />
      <span className="pet__orbit pet__orbit--two" />
      <span className="pet__ear pet__ear--left" />
      <span className="pet__ear pet__ear--right" />
      <span className="pet__tail" />
      <span className="pet__body">
        <span className="pet__face">
          <span className="pet__eye pet__eye--left" />
          <span className="pet__eye pet__eye--right" />
          <span className="pet__mouth" />
        </span>
        <span className="pet__core" />
      </span>
      {!compact && <span className="pet__ground">LUMO–01</span>}
    </div>
  );
}

function SignalBars({ mode }: { mode: PetMode }) {
  return (
    <span className={`signal-bars signal-bars--${mode}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

export default function Home() {
  const [mode, setMode] = useState<PetMode>("working");
  const [expanded, setExpanded] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [elapsed, setElapsed] = useState(127);
  const [progress, setProgress] = useState(modeDetails.working.progress);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const dragStart = useRef({ pointerX: 0, pointerY: 0, x: 0, y: 0 });
  const dragging = useRef(false);
  const current = modeDetails[mode];

  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    setProgress(modeDetails[mode].progress);
    setElapsed(mode === "done" ? 312 : mode === "resting" ? 0 : 127);
  }, [mode]);

  useEffect(() => {
    if (mode !== "working") return;
    const timer = window.setInterval(
      () => setProgress((value) => Math.min(value + 1, 92)),
      3200,
    );
    return () => window.clearInterval(timer);
  }, [mode]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const match = modeButtons.find((item) => item.shortcut === event.key);
      if (match) setMode(match.id);
      if (event.key.toLowerCase() === "e") setExpanded((value) => !value);
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const formattedTime = `${String(Math.floor(elapsed / 60)).padStart(2, "0")}:${String(
    elapsed % 60,
  ).padStart(2, "0")}`;

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragging.current = true;
    dragStart.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: position.x,
      y: position.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    const islandWidth = expanded ? 620 : 360;
    const maxX = Math.max(0, window.innerWidth / 2 - islandWidth / 2 - 12);
    const nextX = dragStart.current.x + event.clientX - dragStart.current.pointerX;
    const nextY = dragStart.current.y + event.clientY - dragStart.current.pointerY;
    setPosition({
      x: Math.min(maxX, Math.max(-maxX, nextX)),
      y: Math.min(window.innerHeight - 120, Math.max(-24, nextY)),
    });
  };

  const endDrag = () => {
    dragging.current = false;
  };

  const islandStyle = {
    "--drag-x": `${position.x}px`,
    "--drag-y": `${position.y}px`,
    "--progress": `${progress * 3.6}deg`,
  } as CSSProperties;

  return (
    <main className="app-shell">
      <nav className="topbar" aria-label="产品导航">
        <a className="brand" href="#top" aria-label="Lumo 首页">
          <span className="brand__mark">C</span>
          <span>Codex Lumo</span>
        </a>
        <div className="topbar__meta">
          <span>FLOATING COMPANION</span>
          <span className="topbar__version">01.4</span>
        </div>
      </nav>

      <div
        className={`island ${expanded ? "island--expanded" : ""}`}
        style={islandStyle}
        data-mode={mode}
        onPointerDown={beginDrag}
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="island__primary">
          <div className="island__pet-wrap">
            <Pet mode={mode} compact />
          </div>

          <button
            className="island__summary"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-label={expanded ? "收起任务详情" : "展开任务详情"}
          >
            <span className="island__eyebrow">
              <span className="status-dot" />
              {current.eyebrow}
            </span>
            <span className="island__title">{current.label}</span>
            <span className="island__detail">{current.detail}</span>
          </button>

          <div className="island__telemetry">
            <SignalBars mode={mode} />
            <span className="island__time">{formattedTime}</span>
          </div>

          <button
            className="progress-ring"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={`任务进度 ${progress}%，点击${expanded ? "收起" : "展开"}`}
          >
            <span>{progress}</span>
          </button>
        </div>

        <div className="island__details" aria-hidden={!expanded}>
          <div className="task-panel">
            <div className="task-panel__head">
              <div>
                <span className="micro-label">CURRENT MISSION</span>
                <h2>构建 Codex 宠物悬浮窗</h2>
              </div>
              <button
                className="sound-button"
                type="button"
                onClick={() => setSoundOn((value) => !value)}
                aria-pressed={soundOn}
              >
                <span aria-hidden="true">{soundOn ? "◖))" : "◖×"}</span>
                {soundOn ? "声音开启" : "声音关闭"}
              </button>
            </div>

            <div className="task-track" aria-label={`任务完成 ${progress}%`}>
              <span style={{ width: `${progress}%` }} />
            </div>

            <div className="task-steps">
              <span className="task-step task-step--done">
                <i>01</i>解析需求
              </span>
              <span className="task-step task-step--done">
                <i>02</i>建立视觉
              </span>
              <span className={`task-step ${mode === "done" ? "task-step--done" : "task-step--active"}`}>
                <i>03</i>验证交互
              </span>
            </div>
          </div>

          <div className="island__footer">
            <span>拖动悬浮窗到任意位置</span>
            <button type="button" onClick={() => setExpanded(false)}>
              收起 <kbd>E</kbd>
            </button>
          </div>
        </div>
      </div>

      <section className="hero" id="top">
        <div className="hero__orbit hero__orbit--one" />
        <div className="hero__orbit hero__orbit--two" />
        <p className="eyebrow">CODEX COMPANION / 2026</p>
        <h1>
          Codex，
          <br />
          有生命了。
        </h1>
        <p className="hero__lead">
          一扇会呼吸的任务窗口。它懂你的进度，
          <br className="desktop-break" />
          也懂得在你思考时安静陪伴。
        </p>
        <div className="hero__actions">
          <button type="button" onClick={() => setExpanded(true)}>
            唤醒 Lumo
          </button>
          <a href="#lab">体验状态</a>
        </div>
        <p className="drag-hint">
          <span>↖</span> 顶部悬浮窗可拖动
        </p>
      </section>

      <section className="showcase" aria-labelledby="pet-title">
        <div className="showcase__copy">
          <p className="eyebrow eyebrow--dark">A QUIET PRESENCE</p>
          <h2 id="pet-title">它不只是状态灯。</h2>
          <p>
            编码时专注扫描，思考时缓慢悬浮，完成后会露出一个小小的笑容。Lumo
            用动作代替打扰。
          </p>
          <div className="spec-list">
            <span><b>04</b> 情绪状态</span>
            <span><b>60</b> FPS 动效</span>
            <span><b>01</b> 克制的强调色</span>
          </div>
        </div>
        <div className="pet-stage">
          <Pet mode={mode} />
          <div className="scan-line" />
          <span className="stage-label stage-label--top">EMOTION SYNC</span>
          <span className="stage-label stage-label--bottom">NEURAL LINK / STABLE</span>
        </div>
      </section>

      <section className="lab" id="lab" aria-labelledby="lab-title">
        <div className="lab__intro">
          <p className="eyebrow">LIVE STATE LAB</p>
          <h2 id="lab-title">让它跟着任务一起变化。</h2>
          <p>选择一种状态，观察悬浮窗和 Lumo 的实时反馈。也可以用数字键 1–4 快速切换。</p>
        </div>

        <div className="mode-switcher" role="group" aria-label="宠物状态">
          {modeButtons.map((item) => (
            <button
              key={item.id}
              type="button"
              className={mode === item.id ? "is-active" : ""}
              onClick={() => setMode(item.id)}
              aria-pressed={mode === item.id}
            >
              <span>{item.label}</span>
              <kbd>{item.shortcut}</kbd>
            </button>
          ))}
        </div>

        <div className="lab__readout">
          <span className="micro-label">SYSTEM READOUT</span>
          <div>
            <span>情绪</span>
            <strong>{current.label}</strong>
          </div>
          <div>
            <span>任务进度</span>
            <strong>{progress}%</strong>
          </div>
          <div>
            <span>专注时长</span>
            <strong>{formattedTime}</strong>
          </div>
          <div>
            <span>连接状态</span>
            <strong>稳定</strong>
          </div>
        </div>
      </section>

      <footer>
        <span>CODEX LUMO / CONCEPT 01</span>
        <span>为长时间创造而设计。</span>
      </footer>
    </main>
  );
}
