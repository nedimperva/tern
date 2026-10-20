// Inbox Zero gets the best screen in the app (docs/design/ui.md §4.7): a different tern scene each day, drawn here
// in SVG (nothing to licence, light and dark from the theme's colours), with the time and one line.

import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import type { Account } from "../api";
import { colourOf } from "../colours";
import {
  clearedThisYear,
  clearedToday,
  dayOfYear,
  type SceneId,
  sceneFor,
  streak,
  thisWeek,
} from "../zero";

/** Tern's tern, the app icon's facets: flying, or sitting on the shore. */
function Tern(props: { at: string; opacity?: number }) {
  return (
    <g transform={props.at} opacity={props.opacity ?? 1}>
      <polygon class="t1" points="10,10 55,48 40,58" />
      <polygon class="t2" points="10,10 40,58 24,50" />
      <polygon class="t3" points="100,4 62,50 52,44" />
      <polygon class="t4" points="100,4 70,40 62,50" />
      <polygon class="t5" points="40,58 55,48 96,60 62,72" />
      <polygon class="t6" points="40,58 16,80 34,68" />
      <polygon class="t7" points="44,64 28,90 48,70" />
      <polygon class="t8" points="96,60 114,58 97,65" />
    </g>
  );
}

function Sitting(props: { at: string; asleep?: boolean }) {
  return (
    <g transform={props.at}>
      <polygon class="t6" points="0,26 -18,18 6,22" />
      <polygon class="t5" points="4,24 34,12 70,16 80,26 44,36" />
      <polygon class="t1" points="14,22 46,10 66,20 40,28" />
      <Show
        when={!props.asleep}
        fallback={
          <>
            <polygon class="t3" points="62,16 74,11 80,20 68,24" />
            <polygon class="cap" points="62,16 74,11 77,15 65,18" />
          </>
        }
      >
        <polygon class="t3" points="66,8 80,2 88,10 82,20 70,18" />
        <polygon class="cap" points="66,8 80,2 88,10 74,10" />
        <polygon class="beak" points="88,10 102,12 86,14" />
      </Show>
    </g>
  );
}

/** Wings swept back, beak first: a tern going into the water. */
function Diving(props: { at: string }) {
  return (
    <g transform={props.at}>
      <polygon class="t1" points="-8,-10 -42,-62 -14,-24" />
      <polygon class="t3" points="8,-10 42,-62 14,-24" />
      <polygon class="t6" points="-4,-20 -12,-46 0,-24" />
      <polygon class="t7" points="4,-20 12,-46 0,-24" />
      <polygon class="t5" points="-8,-20 8,-20 4,40 -4,40" />
      <polygon class="t2" points="-8,-20 0,-20 -4,40" />
      <polygon class="cap" points="-5,40 5,40 0,52" />
      <polygon class="beak" points="-2,52 2,52 0,64" />
    </g>
  );
}

const W = 1100;
const H = 644;

type Scene = {
  /** "side": words on the left, the picture on the right; "center": words at the bottom over a full picture. */
  layout: "side" | "center";
  art: () => JSX.Element;
  kicker?: string;
  /** The big line: the time, or a count. */
  big: string;
  /** Beside the big line, smaller (a count's unit). */
  unit?: string;
  line: string;
  /** Under the words (the week of the streak). */
  extra?: () => JSX.Element;
};

export function InboxZero(props: { accounts: Account[] }) {
  // The time on screen, and the scene, move on by themselves.
  const [now, setNow] = createSignal(new Date());
  const timer = window.setInterval(() => setNow(new Date()), 30_000);
  onCleanup(() => clearInterval(timer));
  const time = () => now().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  const scenes: Record<SceneId, () => Scene> = {
    pole: () => {
      // North at midsummer (day 172), south at midwinter: the tern follows the light.
      const t = (1 - Math.cos((2 * Math.PI * (dayOfYear(now()) - 172)) / 365)) / 2;
      const at = (s: number) => [
        (1 - s) * (1 - s) * 900 + 2 * (1 - s) * s * 420 + s * s * 900,
        (1 - s) * (1 - s) * 36 + 2 * (1 - s) * s * 322 + s * s * 608,
      ];
      const flown = "M" + Array.from({ length: 41 }, (_, i) => at((t * i) / 40).map((v) => v.toFixed(1)).join(" ")).join(" L");
      const [x, y] = at(t);
      return {
        layout: "side",
        kicker: "Inbox zero",
        big: time(),
        line: "The Arctic tern flies from pole to pole and back every year, about 70,000 km. You went the distance today.",
        art: () => (
          <>
            <path class="faint" d="M600 28 h420 M600 616 h420" />
            <path class="route" d="M900 36 Q 420 322 900 608" />
            <path class="flown" d={flown} />
            <circle class="pin done" cx="900" cy="36" r="5" />
            <circle class="pin" cx="900" cy="608" r="5" />
            <text class="label" x="918" y="40">ARCTIC</text>
            <text class="label" x="918" y="612">ANTARCTIC</text>
            <Tern at={`translate(${(x - 28).toFixed(1)} ${(y - 22).toFixed(1)}) scale(0.5)`} />
          </>
        ),
      };
    },

    flock: () => {
      const n = clearedToday();
      const birds = Math.max(5, Math.min(31, n));
      return {
        layout: "center",
        big: n ? String(n) : time(),
        unit: n ? (n === 1 ? "conversation cleared today" : "conversations cleared today") : undefined,
        line: n ? `Inbox zero at ${time()}. The whole flock is home.` : "Inbox zero. The whole flock is home.",
        art: () => (
          <For each={Array.from({ length: birds }, (_, i) => i)}>
            {(i) => {
              // A V flying right: the leader in front, the rest in two wings, smaller and paler further back.
              const rank = Math.ceil(i / 2);
              const side = i % 2 === 0 ? 1 : -1;
              const s = 0.62 - rank * 0.022;
              return <Tern at={`translate(${820 - rank * 54} ${250 + side * rank * 26}) scale(${s.toFixed(3)})`} opacity={1 - rank * 0.035} />;
            }}
          </For>
        ),
      };
    },

    summers: () => {
      // The sun stands over the north at midsummer and over the south half a year later; the tern just behind it.
      const a = ((dayOfYear(now()) - 172) / 365) * 2 * Math.PI;
      const b = a - 0.5;
      return {
        layout: "side",
        kicker: "Inbox zero",
        big: time(),
        line: "The Arctic tern follows summer from north to south and back, and sees more daylight than any other animal. Go and get some.",
        art: () => (
          <>
            <circle class="globe" cx="800" cy="322" r="150" />
            <path class="faint dashed" d="M650 322 h300" />
            <path class="summer" d="M680 230 A 150 150 0 0 1 920 230 M680 414 A 150 150 0 0 0 920 414" />
            <circle class="route" cx="800" cy="322" r="230" />
            <circle class="sun" cx={800 + 196 * Math.sin(a)} cy={322 - 196 * Math.cos(a)} r="26" />
            <text class="label" x="960" y="160">NORTH</text>
            <text class="label" x="960" y="490">SOUTH</text>
            <Tern at={`translate(${(800 + 230 * Math.sin(b) - 28).toFixed(1)} ${(322 - 230 * Math.cos(b) - 22).toFixed(1)}) scale(0.5)`} />
          </>
        ),
      };
    },

    moon: () => ({
      layout: "side",
      kicker: "Inbox zero",
      big: time(),
      line: "Over its life an Arctic tern flies about 2.4 million km: to the Moon and back three times. Today's trip was shorter, and it's done.",
      art: () => (
        <>
          <path class="route" d="M640 520 C 700 300, 860 160, 980 110 M640 520 C 760 360, 900 220, 980 110 M640 520 C 820 420, 950 260, 980 110" />
          <circle class="earth" cx="610" cy="548" r="46" />
          <circle class="moon" cx="1000" cy="96" r="34" />
          <circle class="crater" cx="990" cy="88" r="6" />
          <circle class="crater" cx="1012" cy="106" r="4" />
          <Tern at="translate(800 248) scale(0.62)" />
        </>
      ),
    }),

    streak: () => {
      const n = streak();
      return {
        layout: "center",
        kicker: "Inbox zero",
        big: String(n),
        unit: n === 1 ? "day in a row" : "days in a row",
        line: `Cleared at ${time()}. Terns fly in long stretches too.`,
        art: () => null,
        extra: () => (
          <div class="zero-week">
            <For each={thisWeek(now())}>
              {(d) => (
                <div class="zero-day" classList={{ done: d.done, future: d.future, today: d.isToday }}>
                  <span class="box">
                    <Show when={d.done} fallback={<Show when={!d.future}><span class="missed" /></Show>}>
                      <svg viewBox="0 0 120 100" aria-hidden="true">
                        <Tern at="translate(0 0)" />
                      </svg>
                    </Show>
                  </span>
                  <span class="name">{d.name}</span>
                </div>
              )}
            </For>
          </div>
        ),
      };
    },

    horizon: () => {
      const hour = now().getHours();
      const night = hour >= 19 || hour < 6;
      // The sun's colour changes with the day, so the scene stays a small reward.
      const hue = 12 + ((dayOfYear(now()) * 7) % 40);
      return {
        layout: "center",
        big: time(),
        line: night ? "Inbox zero. Quiet sea tonight." : "Inbox zero. Clear skies all the way out.",
        art: () => (
          <g classList={{ "after-dark": night }}>
            <rect class="sky" width={W} height={H} />
            <Show when={night}>
              <g class="stars">
                <For each={[[96, 70], [210, 140], [330, 54], [470, 110], [560, 40], [660, 150], [900, 64], [1010, 128], [150, 250], [980, 260], [430, 220], [1050, 40]]}>
                  {([x, y]) => <circle cx={x} cy={y} r="1.3" />}
                </For>
              </g>
            </Show>
            <circle cx="790" cy={night ? 300 : 388} r={night ? 40 : 64} style={{ fill: night ? "var(--z-moon)" : `hsl(${hue} 88% 64%)` }} />
            <rect class="sea" y="388" width={W} height={H - 388} />
            <path class="shoreline" d={`M0 388 h${W}`} />
            <path class="glint" style={{ stroke: night ? "var(--z-moon)" : `hsl(${hue} 88% 64%)` }} d="M720 420 h140 M752 440 h76 M776 458 h28" />
            <path class="wave" d="M120 440 h60 M260 470 h90 M520 452 h40 M940 476 h70" />
            <Tern at="translate(300 150) scale(1.35)" />
          </g>
        ),
      };
    },

    colony: () => {
      const accounts = props.accounts;
      const names = accounts.map((a) => a.displayName || a.email);
      const gap = Math.min(220, 760 / Math.max(1, accounts.length));
      const start = W / 2 - (gap * (accounts.length - 1)) / 2;
      return {
        layout: "center",
        big: time(),
        line:
          accounts.length > 1
            ? `Every inbox is clear: ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}.`
            : "Inbox zero. The colony is settled for the day.",
        art: () => (
          <>
            <rect class="sky" width={W} height={H} />
            <rect class="sea" y="300" width={W} height="60" />
            <path class="sand" d={`M0 340 C 300 320, 700 330, ${W} 316 L${W} ${H} L0 ${H} Z`} />
            <For each={accounts}>
              {(a, i) => (
                <g>
                  <ellipse cx={start + i() * gap} cy="400" rx="54" ry="12" style={{ fill: colourOf(accounts, a.id), opacity: 0.28 }} />
                  <Sitting at={`translate(${start + i() * gap - 40} 368)`} />
                </g>
              )}
            </For>
            <Tern at="translate(760 90) scale(0.55)" opacity={0.85} />
          </>
        ),
      };
    },

    migration: () => {
      const total = clearedThisYear();
      const t = dayOfYear(now()) / 365;
      return {
        layout: "side",
        kicker: "Your migration",
        big: total.toLocaleString(),
        unit: total === 1 ? "conversation cleared this year" : "conversations cleared this year",
        line: `Inbox zero at ${time()}. The tern counts kilometres; you count conversations.`,
        art: () => {
          const at = (s: number) => [
            (1 - s) * (1 - s) * 620 + 2 * (1 - s) * s * 820 + s * s * 1020,
            (1 - s) * (1 - s) * 470 + 2 * (1 - s) * s * -130 + s * s * 470,
          ];
          const flown = "M" + Array.from({ length: 41 }, (_, i) => at((t * i) / 40).map((v) => v.toFixed(1)).join(" ")).join(" L");
          const [x, y] = at(t);
          return (
            <>
              <path class="route" d="M620 470 Q 820 -130 1020 470" />
              <path class="flown" d={flown} />
              <circle class="pin done" cx="620" cy="470" r="5" />
              <circle class="pin" cx="1020" cy="470" r="5" />
              <text class="label" x="596" y="500">JAN</text>
              <text class="label" x="1000" y="500">DEC</text>
              <Tern at={`translate(${(x - 28).toFixed(1)} ${(y - 22).toFixed(1)}) scale(0.5)`} />
            </>
          );
        },
      };
    },

    dive: () => ({
      layout: "center",
      big: time(),
      line: "Inbox zero. Straight in, and done.",
      art: () => (
        <>
          <rect class="sky" width={W} height={H} />
          <rect class="sea" y="430" width={W} height={H - 430} />
          <path class="shoreline" d={`M0 430 h${W}`} />
          <g class="ripples">
            <ellipse cx="560" cy="434" rx="30" ry="6" />
            <ellipse cx="560" cy="434" rx="60" ry="11" />
            <ellipse cx="560" cy="434" rx="96" ry="16" />
          </g>
          <g class="diver">
            <Diving at="translate(560 150) scale(1.1)" />
          </g>
        </>
      ),
    }),

    seasons: () => {
      const month = now().getMonth();
      const season = month >= 2 && month <= 4 ? "spring" : month >= 5 && month <= 7 ? "summer" : month >= 8 && month <= 10 ? "autumn" : "winter";
      const line = {
        spring: "Inbox zero. The terns are back on the coast.",
        summer: "Inbox zero. Chicks on the shore, nothing in the inbox.",
        autumn: "Inbox zero. The terns are heading south.",
        winter: "Inbox zero. The shore is quiet until spring.",
      }[season];
      return {
        layout: "center",
        big: time(),
        line,
        art: () => (
          <>
            <rect class="sky" width={W} height={H} />
            <rect class="sea" y="330" width={W} height="70" />
            <path class="sand" d={`M0 380 C 300 360, 700 372, ${W} 352 L${W} ${H} L0 ${H} Z`} />
            <Show when={season === "spring"}>
              <Tern at="translate(820 120) scale(0.6) scale(-1 1) translate(-120 0)" />
              <Tern at="translate(900 170) scale(0.45) scale(-1 1) translate(-120 0)" opacity={0.85} />
            </Show>
            <Show when={season === "summer"}>
              <Sitting at="translate(480 400)" />
              <circle class="chick" cx="580" cy="424" r="11" />
              <circle class="chick" cx="604" cy="428" r="9" />
              <Tern at="translate(700 130) scale(0.55)" />
            </Show>
            <Show when={season === "autumn"}>
              <For each={[0, 1, 2, 3, 4]}>
                {(i) => <Tern at={`translate(${260 - i * 46} ${120 + (i % 2) * 34 + i * 6}) scale(${0.42 - i * 0.03})`} opacity={1 - i * 0.12} />}
              </For>
            </Show>
            <Show when={season === "winter"}>
              <g class="snow">
                <For each={[[120, 80], [260, 160], [400, 60], [540, 200], [700, 110], [860, 70], [980, 190], [330, 260], [800, 250]]}>
                  {([x, y]) => <circle cx={x} cy={y} r="2.5" />}
                </For>
              </g>
              <path class="prints" d="M420 470 l6 -4 M450 460 l6 -4 M480 470 l6 -4 M510 460 l6 -4 M540 470 l6 -4" />
            </Show>
          </>
        ),
      };
    },

    night: () => ({
      layout: "center",
      big: time(),
      line: "Inbox zero. Go to sleep.",
      art: () => (
        <g class="after-dark">
          <rect class="sky" width={W} height={H} />
          <circle cx="860" cy="120" r="34" style={{ fill: "var(--z-moon)" }} />
          <rect class="sea" y="340" width={W} height="60" />
          <path class="sand" d={`M0 380 C 300 360, 700 372, ${W} 352 L${W} ${H} L0 ${H} Z`} />
          <Sitting at="translate(420 392)" asleep />
          <Sitting at="translate(540 400)" asleep />
          <Sitting at="translate(650 388)" asleep />
          <text class="zzz" x="700" y="360">z</text>
          <text class="zzz small" x="716" y="340">z</text>
        </g>
      ),
    }),
  };

  const scene = () => {
    const id = sceneFor(now());
    return { id, ...scenes[id]() };
  };

  return (
    <Show when={scene()}>
      {(s) => (
        <div class={`zero zero-${s().layout} zero-${s().id}`}>
          <svg
            class="zero-art"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio={s().layout === "side" ? "xMaxYMid meet" : "xMidYMid slice"}
            aria-hidden="true"
          >
            {s().art()}
          </svg>
          <div class="zero-words">
            <Show when={s().kicker}>
              <div class="zero-kicker">{s().kicker}</div>
            </Show>
            <div class="zero-big-row">
              <span class="zero-big">{s().big}</span>
              <Show when={s().unit}>
                <span class="zero-unit">{s().unit}</span>
              </Show>
            </div>
            <div class="zero-line">{s().line}</div>
            {s().extra?.()}
          </div>
        </div>
      )}
    </Show>
  );
}
