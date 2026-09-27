'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { journeys, places, themes, type JourneyKey, type Place, type ThemeFilter } from './places';
import { regionLabels, regions, peaks, seas } from './geo';
import { toTraditional } from './zh-hant';
import { toEnglish } from './en';
import { placeVideo, videos } from './videos';
import {
  clamp, clampPan, DRAFT_STRIDE, drawScene, elevationRange, groundAt, hypsometric, JOURNEY_TINT,
  makeFrame, normLat, normLon, project, regionAt, relief, STATUS_TINT, TILT, zoomAbout,
  type Frame, type View,
} from './terrain';

const STATUSES: { key: keyof typeof STATUS_TINT; name: string; note: string }[] = [
  { key: 'italia', name: '意大利本土', note: '罗马与坎帕尼亚' },
  { key: 'senatorial', name: '元老院行省', note: '亚该亚 · 亚细亚 · 居比路 · 革哩底' },
  { key: 'imperial', name: '皇帝行省', note: '叙利亚 · 加拉太 · 犹太 · 埃及' },
  { key: 'client', name: '附庸王国', note: '拿巴天 · 色雷斯' },
];

/** Which theme filter each journey route belongs to. */
const JOURNEY_THEME: Record<JourneyKey, ThemeFilter> = {
  first: '第一程', second: '第二程', third: '第三程', rome: '赴罗马',
};

type Lang = 'hans' | 'hant' | 'en';
const LANGS: [Lang, string][] = [['hans', '简'], ['hant', '繁'], ['en', 'EN']];
// slashai.app pages share the visitor language under the slashai.lang key
// (zh, tw or en, JSON-encoded). The older per-site script key is still read
// so returning visitors keep their choice.
const SHARED_LANG: Record<string, Lang> = { zh: 'hans', tw: 'hant', en: 'en' };
function initialLang(): Lang {
  if (typeof window === 'undefined') return 'hans';
  try {
    const shared = SHARED_LANG[JSON.parse(localStorage.getItem('slashai.lang') ?? 'null')];
    if (shared) return shared;
    const saved = localStorage.getItem('script');
    if (saved === 'hans' || saved === 'hant' || saved === 'en') return saved;
  } catch { /* private mode */ }
  const nav = (navigator.language || 'en').toLowerCase();
  if (!nav.startsWith('zh')) return 'en';
  return /hant|tw|hk|mo/.test(nav) ? 'hant' : 'hans';
}
function rememberLang(code: Lang) {
  const shared = Object.keys(SHARED_LANG).find((key) => SHARED_LANG[key] === code);
  try { localStorage.setItem('slashai.lang', JSON.stringify(shared)); localStorage.setItem('script', code); } catch { /* private mode */ }
}
const CONVERT: Record<Lang, ((s: string) => string) | null> = {
  hans: null, hant: toTraditional, en: toEnglish,
};
const HTML_LANG: Record<Lang, string> = { hans: 'zh-CN', hant: 'zh-Hant', en: 'en' };

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

/** Kept out of the JSX so the English-table extractor sees one plain literal. */
const STAGE_LABEL = '地形视图 · 方向键平移，Shift + 方向键旋转俯仰，加减号缩放';

/** Travel, in pixels, past which a press is a drag rather than a click. */
const DRAG = 4;

const DEFAULT_VIEW: View = { rotation: 0, tilt: 0.78, zoom: 1, perspective: false, panX: 0, panY: 0 };

/**
 * The control scheme Google Earth uses. Drag the ground to pan it, hold Ctrl / Shift
 * or use the right or middle button to orbit, wheel towards the cursor to zoom,
 * two fingers to pinch, twist and tilt, double-click to zoom into a point.
 *
 * The listeners are native rather than React props because React registers
 * `wheel` passively, so its handler cannot cancel the page scroll.
 *
 * Returns the zoom primitive so the on-screen buttons and the keyboard reuse
 * the same cursor-anchored maths.
 */
function useEarthControls(
  ref: React.RefObject<HTMLDivElement | null>,
  view: View,
  setView: React.Dispatch<React.SetStateAction<View>>,
) {
  const viewRef = useRef(view);
  useEffect(() => { viewRef.current = view; }, [view]);

  const zoomAt = useCallback((factor: number, px?: number, py?: number) => {
    const el = ref.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    setView((v) => zoomAbout(v, factor, px ?? w / 2, py ?? h / 2, w, h));
  }, [ref, setView]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { mode: 'pan' | 'orbit'; x: number; y: number; from: View } | null = null;
    let pinch: { dist: number; angle: number; x: number; y: number } | null = null;
    let travel = 0;

    /**
     * Overlay controls swallow a gesture, the site markers do not — they cover
     * enough of the land that bailing on them would leave dead patches you
     * cannot drag from. A marker still selects on a click; `travel` is what
     * separates that click from the tail of a pan.
     */
    const chrome = (e: Event) => {
      const hit = (e.target as HTMLElement).closest('button, a');
      return hit !== null && !hit.classList.contains('map-marker');
    };

    const twoFinger = () => {
      const [a, b] = [...pointers.values()];
      return {
        dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
        angle: Math.atan2(b.y - a.y, b.x - a.x),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };

    const grab = (mode: 'pan' | 'orbit', x: number, y: number) => {
      drag = { mode, x, y, from: viewRef.current };
      el.dataset.grab = mode;
    };

    /**
     * Capture once the gesture is a drag, never on the first move. A captured
     * pointer retargets its click to the capturing element, and a hand moves a
     * pixel or two inside every click, so capturing eagerly means a site is
     * never selected. One threshold decides both, so a gesture either captures
     * and has its click suppressed, or does neither.
     */
    const hold = (pointerId: number) => {
      if (travel > DRAG && !el.hasPointerCapture(pointerId)) el.setPointerCapture(pointerId);
    };

    const onPointerDown = (e: PointerEvent) => {
      // Before the bail, not after: a press on an overlay control still has to
      // clear the previous gesture, or the click suppression below eats it.
      travel = 0;
      if (chrome(e)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        grab(e.button === 1 || e.button === 2 || e.ctrlKey || e.metaKey || e.shiftKey ? 'orbit' : 'pan',
          e.clientX, e.clientY);
      } else {
        drag = null;
        pinch = twoFinger();
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size >= 2 && pinch) {
        const now = twoFinger();
        const was = pinch;
        pinch = now;
        travel = DRAG + 1;
        hold(e.pointerId);
        setView((v) => ({
          ...v,
          rotation: v.rotation + (now.angle - was.angle),
          tilt: clamp(v.tilt + (now.y - was.y) * 0.004, TILT.min, TILT.max),
        }));
        const box = el.getBoundingClientRect();
        zoomAt(now.dist / was.dist, now.x - box.left, now.y - box.top);
        return;
      }

      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      travel = Math.max(travel, Math.hypot(dx, dy));
      hold(e.pointerId);
      const from = drag.from;
      if (drag.mode === 'pan') {
        setView((v) => ({
          ...v,
          panX: clampPan(from.panX + dx, el.clientWidth),
          panY: clampPan(from.panY + dy, el.clientHeight),
        }));
      } else {
        setView((v) => ({
          ...v,
          rotation: from.rotation + dx * 0.006,
          tilt: clamp(from.tilt + dy * 0.004, TILT.min, TILT.max),
        }));
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (pointers.size === 1) {
        // Lifting one finger of a pinch hands the gesture to the one still down.
        const [rest] = [...pointers.values()];
        grab('pan', rest.x, rest.y);
      } else if (pointers.size === 0) {
        drag = null;
        delete el.dataset.grab;
      }
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const box = el.getBoundingClientRect();
      // Line-mode wheels report a few lines, a trackpad pinch reports tiny
      // pixel deltas with ctrlKey set; both need scaling into the same range.
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1) * (e.ctrlKey ? 5 : 1);
      zoomAt(Math.exp(-clamp(delta, -400, 400) * 0.0016), e.clientX - box.left, e.clientY - box.top);
    };

    // A pan that ends over a marker must not also select it.
    const onClickCapture = (e: MouseEvent) => {
      if (travel > DRAG) { e.stopPropagation(); e.preventDefault(); }
    };

    const onDoubleClick = (e: MouseEvent) => {
      if (chrome(e)) return;
      const box = e.currentTarget instanceof Element
        ? e.currentTarget.getBoundingClientRect() : el.getBoundingClientRect();
      zoomAt(e.shiftKey ? 1 / 1.7 : 1.7, e.clientX - box.left, e.clientY - box.top);
    };

    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('click', onClickCapture, true);
    el.addEventListener('dblclick', onDoubleClick);
    el.addEventListener('contextmenu', onContextMenu);
    return () => {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('click', onClickCapture, true);
      el.removeEventListener('dblclick', onDoubleClick);
      el.removeEventListener('contextmenu', onContextMenu);
    };
  }, [ref, setView, zoomAt]);

  return zoomAt;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 1200, height: 820 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function TerrainCanvas({ view, size, showRegions, highlightRegion, showJourneys, activeJourney }: {
  view: View; size: { width: number; height: number }; showRegions: boolean; highlightRegion: number;
  showJourneys: JourneyKey[]; activeJourney: JourneyKey | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(size.width * dpr);
    canvas.height = Math.round(size.height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const frame = makeFrame(view, size.width, size.height);
    const draw = (stride: number) =>
      drawScene(ctx, size.width, size.height, frame,
        { stride, showRegions, highlightRegion, showJourneys, activeJourney });
    // Coarse mesh right away so dragging stays responsive, full grid once it settles.
    draw(DRAFT_STRIDE);
    const id = setTimeout(() => draw(1), 200);
    return () => clearTimeout(id);
  }, [view, size, showRegions, highlightRegion, showJourneys, activeJourney]);

  return <canvas ref={canvasRef} className="terrain-canvas" style={{ width: size.width, height: size.height }} aria-hidden="true" />;
}

function Compass({ rotation, onReset }: { rotation: number; onReset: () => void }) {
  return (
    <button className="compass" onClick={onReset} aria-label="正北朝上">
      <div className="compass-ring" style={{ transform: `rotate(${rotation}rad)` }}>
        <span className="north">N</span>
        <span className="south">S</span>
        <i />
      </div>
    </button>
  );
}

export default function Home() {
  const [activeId, setActiveId] = useState('antioch-syria');
  const [filter, setFilter] = useState<ThemeFilter>('全部');
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [showRegions, setShowRegions] = useState(true);
  const [showTowns, setShowTowns] = useState(false);
  const [showRoutes, setShowRoutes] = useState(true);
  // Closed to start with. The frame is 26° wide and the panel covers its eastern
  // third — Judaea, Syria, Cyprus — which is where the book begins.
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * Nothing is requested from YouTube until this is set. An iframe per panel
   * would pull a player, its cookies and a few hundred kilobytes on every place
   * you click, so the embed only exists once someone asks for it — and it is
   * keyed by place id so moving to another site puts the poster back.
   */
  const [playing, setPlaying] = useState<string | null>(null);
  const [lang, setLang] = useState<Lang>(initialLang);
  const { ref: mapRef, size } = useSize<HTMLDivElement>();
  const zoomAt = useEarthControls(mapRef, view, setView);

  const active = places.find((p) => p.id === activeId) ?? places[0];
  const story = useMemo(() => places.filter((p) => p.kind === 'acts'), []);
  const frame: Frame = useMemo(() => makeFrame(view, size.width, size.height), [view, size]);

  const highlightRegion = useMemo(() => regionAt(active.lon, active.lat), [active]);

  const video = placeVideo[active.id] ? videos[placeVideo[active.id]] : null;

  /**
   * Routes follow the filter: pick a journey and only that line is drawn bright.
   * The whole itinerary stays on screen even when the filter has hidden some of
   * its stops, because the shape of the journey is the point of the layer.
   */
  const { showJourneys, activeJourney } = useMemo(() => {
    const keys = journeys.map((j) => j.key);
    if (!showRoutes) return { showJourneys: [] as JourneyKey[], activeJourney: null };
    const picked = keys.find((k) => JOURNEY_THEME[k] === filter) ?? null;
    return { showJourneys: keys, activeJourney: picked };
  }, [filter, showRoutes]);

  const visible = useMemo(
    () => places.filter((p) => {
      if (!showTowns && p.kind !== 'acts') return false;
      return filter === '全部' || p.theme === filter;
    }),
    [filter, showTowns],
  );

  /**
   * Marker geometry, measured off the rendered CSS: the dot spans -6..+12 across
   * the anchor once hover scales it, and a name starts 17px out on whichever side
   * it is placed.
   */
  const DOT = { x0: -6, x1: 12, y0: -9, y1: 9 };
  const NAME_OFFSET = 17;

  type Box = { x0: number; x1: number; y0: number; y1: number };
  const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

  /**
   * Greedy label declutter: dots always draw, names drop out when they would
   * collide with one already placed. Narrated sites outrank background towns,
   * the selected site outranks everything, and near beats far on a tie.
   *
   * Every dot is reserved before any name is placed. Both are clickable and the
   * topmost wins, so a name lying over a neighbouring dot does not merely look
   * untidy, it takes the clicks meant for that site. A name blocked on the right
   * is tried on the left before it is dropped.
   */
  const markers = useMemo(() => {
    const rank = (p: Place) =>
      (p.id === activeId ? 30 : 0) + (p.kind === 'acts' ? 10 : p.kind === 'port' ? 4 : 0);
    const laid = visible
      .map((p) => {
        const q = project(normLon(p.lon), normLat(p.lat), groundAt(p.lon, p.lat), frame);
        const wide = p.kind === 'acts' || p.id === activeId;
        return {
          place: p,
          x: q.x,
          y: q.y,
          z: Math.round((q.depth + 1) * 200),
          w: (lang === 'en'
            ? toEnglish(p.name).length * (wide ? 7.5 : 5.5)
            : p.name.length * (wide ? 15 : 12)) + 34,
          h: wide ? 37 : 24,
          label: true,
          flip: false,
        };
      })
      .sort((a, b) => rank(b.place) - rank(a.place) || b.z - a.z);

    const dots: Box[] = laid.map((m) => ({
      x0: m.x + DOT.x0, x1: m.x + DOT.x1, y0: m.y + DOT.y0, y1: m.y + DOT.y1,
    }));
    const taken: Box[] = [];
    laid.forEach((m, i) => {
      const y0 = m.y - m.h / 2;
      const y1 = m.y + m.h / 2;
      const sides = [
        { flip: false, box: { x0: m.x + NAME_OFFSET, x1: m.x + NAME_OFFSET + m.w, y0, y1 } },
        { flip: true, box: { x0: m.x - NAME_OFFSET - m.w, x1: m.x - NAME_OFFSET, y0, y1 } },
      ];
      // Its own dot is the one a name is allowed to sit beside.
      const free = sides.find(({ box }) =>
        !taken.some((t) => hits(box, t)) && !dots.some((d, j) => j !== i && hits(box, d)));
      if (free) {
        m.flip = free.flip;
        taken.push(free.box);
      } else {
        m.label = false;
      }
    });
    return laid;
  }, [visible, frame, activeId, lang]);

  const anchor = useCallback((lon: number, lat: number) => {
    const p = project(normLon(lon), normLat(lat), groundAt(lon, lat), frame);
    return { left: p.x, top: p.y, zIndex: Math.round((p.depth + 1) * 200) };
  }, [frame]);

  const selectPlace = (place: Place) => {
    setActiveId(place.id);
    setPanelOpen(true);
  };

  const step = (delta: number) => {
    const i = story.findIndex((p) => p.id === active.id);
    const base = i < 0 ? 0 : i;
    selectPlace(story[(base + delta + story.length) % story.length]);
  };

  /**
   * Language switch. Every visible string is authored in simplified Chinese and
   * lives in the DOM (the canvas draws no text), so the swap runs over text
   * nodes after each render rather than threading a translation call through
   * every component. Traditional is a script conversion, English a lookup in
   * app/en.json; both take the simplified text as their source. Anything inside
   * [data-no-convert] is left alone — the toggle has to keep showing 简 and 繁
   * in their own scripts.
   *
   * `rendered` is what we last wrote. If a node no longer matches it, React has
   * replaced the text and the new value becomes the source.
   */
  const written = useRef(new WeakMap<Node, { source: string; rendered: string }>());
  const converted = useRef(false);
  useEffect(() => {
    const convert = CONVERT[lang];
    if (!convert && !converted.current) return;
    converted.current = convert !== null;
    document.documentElement.lang = HTML_LANG[lang];

    const store = written.current;
    const swap = (node: Node, read: () => string, write: (value: string) => void) => {
      const record = store.get(node);
      const current = read();
      const source = record && current === record.rendered ? record.source : current;
      if (convert) {
        const rendered = convert(source);
        if (current !== rendered) write(rendered);
        store.set(node, { source, rendered });
      } else if (record) {
        if (current !== source) write(source);
        store.delete(node);
      }
    };

    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode: (node) =>
          node.nodeType === Node.ELEMENT_NODE
            ? (node as Element).hasAttribute('data-no-convert')
              ? NodeFilter.FILTER_REJECT
              : NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_ACCEPT,
      },
    );
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text;
      swap(text, () => text.nodeValue ?? '', (value) => { text.nodeValue = value; });
    }

    // Labels read by assistive technology follow the visible script too.
    for (const el of document.querySelectorAll('[aria-label]:not([data-no-convert])')) {
      swap(el, () => el.getAttribute('aria-label') ?? '', (value) => el.setAttribute('aria-label', value));
    }
  });

  // The tint ramp is not linear in metres, so build the legend from the same
  // function the terrain uses.
  const rampCss = useMemo(() => {
    const { hi } = elevationRange;
    const stops = Array.from({ length: 25 }, (_, i) => {
      const [r, g, b] = hypsometric((hi * i) / 24);
      return `rgb(${r | 0},${g | 0},${b | 0}) ${((i / 24) * 100).toFixed(1)}%`;
    });
    return `linear-gradient(90deg, ${stops.join(',')})`;
  }, []);

  const distanceToJerusalem = useMemo(() => {
    const j = places.find((p) => p.id === 'jerusalem')!;
    const dLat = (active.lat - j.lat) * 110.57;
    const dLon = (active.lon - j.lon) * 111.32 * Math.cos(((active.lat + j.lat) / 2) * Math.PI / 180);
    return Math.round(Math.hypot(dLat, dLon));
  }, [active]);

  return (
    <main className="site-shell">
      <header className="topbar">
        <div className="brand">
          <a className="brand-mark" href="https://slashai.app/" aria-label="slashai.app" title="slashai.app">✦</a>
          <a href="#top" aria-label="使徒行传之地首页"><b>直到地极</b><small>使徒行传 · 互动地形志</small></a>
        </div>
        <div className="era"><span /> 公元 30–62 年</div>
        <nav aria-label="主导航">
          <a href="#map">探索地图</a>
          <a href="#guide">阅读指南</a>
          <a className="about-button" href="#sources">资料来源</a>
          <div className="script-toggle" data-no-convert role="group" aria-label="语言 / Language">
            {LANGS.map(([code, label]) => (
              <button
                key={code}
                className={lang === code ? 'on' : ''}
                aria-pressed={lang === code}
                onClick={() => { setLang(code); rememberLang(code); }}
              >
                {label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <div className="eyebrow"><span /> THE ACTS OF THE APOSTLES</div>
          <h1>从耶路撒冷<br />到<em>罗马</em></h1>
          <p>地形取自 GMRT 全球多分辨率地形合成数据集（按约 2.8 公里网格取样），海岸线由高程本身划出，行省疆界还原公元 50 年前后的格局。使徒行传是一部走出去的书：转动这片海，看保罗四段行程如何一次比一次远。</p>
          <button className="primary-button" onClick={() => document.querySelector('#map')?.scrollIntoView({ behavior: 'smooth' })}>
            开始探索 <span>↘</span>
          </button>
        </div>
        <div className="hero-note"><span>01</span><p>垂直方向放大约 20 倍，否则整片高地在这个跨度下几乎是平的。平面位置与高程数值均为实测值。</p></div>
      </section>

      <section className="map-section" id="map" aria-label="使徒行传互动地图">
        <div
          className="map-stage"
          ref={mapRef}
          tabIndex={0}
          role="application"
          aria-label={STAGE_LABEL}
          onKeyDown={(e) => {
            const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (nudge) {
              const [kx, ky] = nudge;
              setView((v) => e.shiftKey
                ? { ...v, rotation: v.rotation + kx * 0.12, tilt: clamp(v.tilt + ky * 0.08, TILT.min, TILT.max) }
                : {
                    ...v,
                    panX: clampPan(v.panX - kx * 60, size.width),
                    panY: clampPan(v.panY - ky * 60, size.height),
                  });
            } else if (e.key === '+' || e.key === '=') zoomAt(1.25);
            else if (e.key === '-' || e.key === '_') zoomAt(1 / 1.25);
            else if (e.key === '0') setView((v) => ({ ...DEFAULT_VIEW, perspective: v.perspective }));
            else return;
            e.preventDefault();
          }}
        >
          <TerrainCanvas
            view={view} size={size} showRegions={showRegions} highlightRegion={highlightRegion}
            showJourneys={showJourneys} activeJourney={activeJourney}
          />

          {showRegions && regionLabels.map((r) => (
            <div className="region-label" key={r.name} style={anchor(r.lon, r.lat)}>
              <b>{r.name}</b><span>{r.sub}</span>
            </div>
          ))}

          {seas.map((sea) => {
            const p = project(normLon(sea.lon), normLat(sea.lat), 0, frame);
            return (
              <div className="water-label" key={sea.name} style={{ left: p.x, top: p.y }}>
                <b>{sea.name}</b><span>{sea.sub}</span>
              </div>
            );
          })}

          {peaks.map((pk) => (
            <div className="peak-label" key={pk.name} style={anchor(pk.lon, pk.lat)}>
              <i>▲</i><b>{pk.name}</b><span>{pk.elev} m</span>
            </div>
          ))}

          {markers.map(({ place, x, y, z, label, flip }) => (
            <button
              key={place.id}
              className={`map-marker kind-${place.kind} ${activeId === place.id ? 'active' : ''} ${label ? '' : 'no-label'} ${flip ? 'flip' : ''}`}
              style={{ left: x, top: y, zIndex: z }}
              onClick={() => selectPlace(place)}
              aria-label={place.name}
            >
              <span className="marker-dot"><i /></span>
              <span className="marker-label"><b>{place.name}</b><small>{place.greek}</small></span>
            </button>
          ))}

          <div className="map-heading">
            <span>历史地理档案 · 02</span>
            <h2>使徒行传的世界</h2>
            <div className="terrain-stats">
              30.0–42.5°N <i /> 11.5–37.5°E <i /> GMRT · 2.8 km 网格
            </div>
          </div>

          <div className="elevation-legend" aria-label="高程图例">
            <div className="legend-ramp" style={{ background: rampCss }} />
            <div className="legend-ticks">
              <b>0 m</b>
              <b>{Math.round(elevationRange.hi)} m</b>
            </div>
            <small>实测高程 · 垂直放大 20×</small>
          </div>

          <div className="map-legends">
          <div className="journey-legend" aria-label="保罗的行程">
            <h4>保罗的行程</h4>
            {journeys.map((j) => (
              <button
                key={j.key}
                className={activeJourney === j.key ? 'on' : ''}
                onClick={() => setFilter(activeJourney === j.key ? '全部' : JOURNEY_THEME[j.key])}
              >
                <i style={{ background: rgb(JOURNEY_TINT[j.key]) }} />
                <b>{j.name}</b><span>{j.note}</span>
              </button>
            ))}
          </div>

          <div className="ruler-legend" aria-label="公元 50 年前后的行省地位">
            <h4>公元 50 年前后的行省</h4>
            {STATUSES.map((r) => (
              <div key={r.key} className={regions[highlightRegion]?.status === r.key ? 'on' : ''}>
                <i style={{ background: rgb(STATUS_TINT[r.key]) }} />
                <b>{r.name}</b><span>{r.note}</span>
              </div>
            ))}
          </div>
          </div>

          <div className="view-tools" aria-label="地图视图控制">
            <button onClick={() => zoomAt(1.25)} aria-label="放大">＋</button>
            <button onClick={() => zoomAt(1 / 1.25)} aria-label="缩小">−</button>
            <button onClick={() => setView((v) => ({ ...DEFAULT_VIEW, perspective: v.perspective }))} aria-label="重置视图">⌂</button>
            <button className={view.perspective ? 'on' : ''} onClick={() => setView((v) => ({ ...v, perspective: !v.perspective }))} aria-label="切换透视投影">⏢</button>
            <button className={showRegions ? 'on' : ''} onClick={() => setShowRegions((s) => !s)} aria-label="切换行省疆界">▧</button>
            <button className={showRoutes ? 'on' : ''} onClick={() => setShowRoutes((s) => !s)} aria-label="切换行程路线">↝</button>
            <button className={showTowns ? 'on' : ''} onClick={() => setShowTowns((s) => !s)} aria-label="切换沿途港口与城邑">◦</button>
          </div>
          <Compass rotation={view.rotation} onReset={() => setView((v) => ({ ...v, rotation: 0 }))} />

          <div className="filter-bar" aria-label="行程阶段筛选">
            {themes.map((item) => (
              <button key={item} className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>{item}</button>
            ))}
          </div>

          <div className="map-hint"><span>✥</span> 拖动平移 · Shift 或右键拖动旋转俯仰 · 滚轮缩放 · 双击放大</div>

          <aside className={`story-panel ${panelOpen ? 'open' : ''}`} aria-live="polite">
            <button className="close-panel" onClick={() => setPanelOpen(false)} aria-label="关闭地点详情">×</button>
            <div className="panel-index">
              {String(places.indexOf(active) + 1).padStart(2, '0')} <span>/ {places.length}</span>
            </div>
            <div className="panel-tag">{active.region} · {active.theme}</div>
            <h3>{active.name}</h3>
            <div className="ancient-name">{active.greek}</div>
            {active.site && <div className="modern-site">今址 · {active.site}</div>}
            <div className="story-rule"><span /></div>
            {active.title && <p className="story-title">{active.title}</p>}
            <p className="story-description">{active.description}</p>
            {active.reference && (
              <div className="reference"><small>经文索引</small><b>{active.reference}</b></div>
            )}
            {video && (
              <div className="video">
                {playing === active.id ? (
                  <iframe
                    className="video-frame"
                    src={`https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`}
                    title={video.source}
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                  />
                ) : (
                  <button className="video-open" onClick={() => setPlaying(active.id)}>
                    <span className="video-play"><i /></span>
                    <span className="video-name"><b>{video.title}</b><small>{video.source}</small></span>
                  </button>
                )}
                <a
                  className="video-credit"
                  href={`https://www.youtube.com/watch?v=${video.id}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  影片来源 · BibleProject ↗
                </a>
              </div>
            )}
            {active.date && (
              <div className="date-row"><span>◷</span><div><small>时间线</small><b>{active.date}</b></div></div>
            )}
            <div className="date-row"><span>↥</span><div><small>海拔</small><b>{active.elev} 米</b></div></div>
            <div className="date-row"><span>⌖</span><div><small>坐标</small><b>{active.lat.toFixed(4)}°N, {active.lon.toFixed(4)}°E</b></div></div>
            <div className="date-row"><span>↔</span><div><small>距耶路撒冷直线</small><b>{distanceToJerusalem} 公里</b></div></div>
            <div className="panel-nav">
              <button onClick={() => step(-1)} aria-label="上一个地点">←</button>
              <div>{story.map((p) => <i key={p.id} className={p.id === active.id ? 'active' : ''} />)}</div>
              <button onClick={() => step(1)} aria-label="下一个地点">→</button>
            </div>
          </aside>
        </div>
      </section>

      <section className="guide" id="guide">
        <div className="guide-intro">
          <span className="eyebrow"><i /> HOW TO READ THE MAP</span>
          <h2>海路与山路<br />决定了<em>次序</em></h2>
        </div>
        <div className="guide-grid">
          <article>
            <span>01</span><h3>一句话的地理提纲</h3>
            <p>「在耶路撒冷、犹太全地和撒马利亚，直到地极作我的见证。」全书二十八章就是这句话的展开：前七章不出耶路撒冷，第八章到撒马利亚，第十三章离开叙利亚，最后一章停在罗马的租处。</p>
          </article>
          <article>
            <span>02</span><h3>夏天走海，冬天不走</h3>
            <p>古代地中海的航期大致从五月到十月。保罗的行程被这条季节线切成段：第三程赶在五旬节前回耶路撒冷，赴罗马的船拖到禁食节期之后才开，结果在革哩底南面遇上狂风，在米利大过了整整一冬。</p>
          </article>
          <article>
            <span>03</span><h3>从海边到高原的那一段</h3>
            <p>别加在海平面附近，彼西底的安提阿在一千二百米的高原上，中间隔着陶鲁斯山与强盗出没的山口。第一程翻过这道墙之后，宣教的重心就从沿海城市转到了内陆殖民城。</p>
          </article>
        </div>
        <div className="source-note" id="sources">
          <p>
            高程：GMRT 全球多分辨率地形合成数据集，按 0.025°（约 2.8 公里）网格重采样，共 {'521,541'} 个采样点，由 GMRT 网格服务一次取得。 海岸线不另取矢量，而是由高程本身划出：该数据集含海底地形，建表时把约旦裂谷以外的负高程一律写为零，零米等值线便是海岸；陆地抬到至少 1 米，低平的海岸才不会被误判为水面。裂谷之内保留真实深度，死海与加利利海因此仍是水。 公元 50 年前后的行省疆界与古代地名为教育性近似；行程连线按使徒行传所记的停靠次序绘制，取两地之间的罗马大道或最合理的航路，并非实测轨迹。
          </p>
          <div>
            <a href="https://www.gmrt.org/" target="_blank" rel="noreferrer">GMRT ↗</a>
            <a href="https://www.gmrt.org/services/index.html" target="_blank" rel="noreferrer">GMRT GridServer ↗</a>
          </div>
        </div>
      </section>

      <footer><span>直到地极</span><p>以地理为线索 · 重读使徒行传</p><a href="#top">回到顶部 ↑</a></footer>
    </main>
  );
}
