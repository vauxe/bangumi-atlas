import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  interactionHint,
  NodeStyleExtension,
  queryHighlightItems,
  Scene,
} from "../src/scene";
import { FOCUS_ZOOM } from "../src/camera";
import type { OrbitState } from "../src/camera";
import { state } from "../src/store";

const projectedCommonPixels = (
  value: number,
  zoom: number,
  minPixels: number,
  maxPixels: number,
): number => Math.min(Math.max(value * 2 ** zoom, minPixels), maxPixels);

test("keeps one desktop graph interaction model and documents its controls", () => {
  const sceneSource = readFileSync("src/scene.ts", "utf8");
  const mainSource = readFileSync("src/main.ts", "utf8");
  const pageSource = readFileSync("../site/index.html", "utf8");

  assert.doesNotMatch(sceneSource, /addEventListener\(\s*["']dblclick["']/);
  assert.doesNotMatch(mainSource, /双击/);
  for (const operation of [
    "拖动平移",
    "右键拖动旋转",
    "滚轮缩放",
    "单击查看",
    "S 搜索",
    "T 俯视",
    "R 复位",
  ]) assert.match(`${mainSource}\n${sceneSource}`, new RegExp(operation));
  assert.doesNotMatch(sceneSource, /touchRotate/);
  assert.doesNotMatch(mainSource, /coarsePointer|\(pointer:\s*coarse\)/);
  assert.doesNotMatch(pageSource, /@media\s*\(max-width:/);
  assert.equal(
    interactionHint(true),
    "拖动平移 · 右键拖动旋转 · 滚轮缩放 · 单击查看 · S 搜索 · T 俯视 · R 复位 · 单击空白或 Esc 取消选择",
  );
  assert.equal(
    interactionHint(false),
    "拖动平移 · 右键拖动旋转 · 滚轮缩放 · 单击查看 · S 搜索 · T 俯视 · R 复位",
  );
});

test("keeps the desktop shell fluid without resolution-specific breakpoints", () => {
  const pageSource = readFileSync("../site/index.html", "utf8");
  const root = pageSource.match(/:root\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const drawerOpen = pageSource.match(
    /body:has\(#drawer\.open\)\s*\{(?<body>[^}]*)\}/s,
  )?.groups?.body ?? "";
  const queryDock = pageSource.match(/#query-dock\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const drawer = pageSource.match(/#drawer\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";
  const legend = pageSource.match(/#legend\s*\{(?<body>[^}]*)\}/s)
    ?.groups?.body ?? "";

  assert.match(root, /--drawer-width:\s*min\(100dvw,\s*clamp\(/);
  assert.match(drawerOpen, /--occupied-right:\s*var\(--drawer-width\)/);
  assert.match(queryDock, /display:\s*grid/);
  assert.match(
    queryDock,
    /grid-template-columns:\s*minmax\(0,\s*var\(--query-max-width\)\)\s+var\(--floating-action-size\)/,
  );
  assert.match(
    queryDock,
    /100dvw\s*-\s*var\(--occupied-right\)\s*-\s*var\(--page-inset\)\s*-\s*var\(--page-inset\)/,
  );
  assert.match(drawer, /width:\s*var\(--drawer-width\)/);
  assert.match(legend, /100dvw\s*-\s*var\(--occupied-right\)/);
  assert.doesNotMatch(pageSource, /@media\s*\([^)]*(?:width|resolution)/);
});

test("commits the final camera frame after the view callback returns", async () => {
  const events: string[] = [];
  const next: OrbitState = {
    target: [9, 8, 7],
    zoom: 4,
    rotationX: 25,
    rotationOrbit: 0,
  };
  const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
    camera: {
      viewState: { ...next, target: [0, 0, 0], zoom: 1 },
      absorb(viewState: OrbitState): void {
        this.viewState = viewState;
      },
      view: () => (events.push("view"), {}),
    },
    deck: { setProps: () => events.push("deck") },
    cb: { onViewChange: () => events.push("state") },
    render: () => events.push("layers"),
  });
  const handle = Reflect.get(scene, "handleViewStateChange") as (
    change: {
      viewState: OrbitState;
      interactionState: { inTransition: boolean; isDragging: boolean };
    },
  ) => OrbitState;
  const finalState = handle.call(scene, {
    viewState: next,
    interactionState: { inTransition: true, isDragging: false },
  });

  assert.deepEqual(finalState.target, next.target);
  assert.deepEqual(events, ["state"]);

  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(events, ["state", "view", "deck", "layers"]);
});

test("clamps the final context-node radius in screen pixels", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const sizeFilter = shaders.inject["vs:DECKGL_FILTER_SIZE"] ?? "";
  assert.match(
    sizeFilter,
    /float radius = abs\(size\.x\) -/,
  );
  assert.match(
    sizeFilter,
    /float screenRadius = radius \* project\.focalDistance \/ gl_Position\.w;/,
  );
  assert.match(
    sizeFilter,
    /clamp\(screenRadius, scatterplot\.radiusMinPixels,\s*scatterplot\.radiusMaxPixels\) \/ screenRadius/,
  );
  assert.doesNotMatch(sizeFilter, /outerRadiusPixels/);
});

test("keeps normal node color independent of zoom, size, and SDF edge alpha", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const colorFilter = shaders.inject["fs:DECKGL_FILTER_COLOR"] ?? "";
  const nodeShaders = Object.values(shaders.inject).join("\n");

  assert.doesNotMatch(
    nodeShaders,
    /atlas\.zoom|atlas_reveal|atlas_keep|atlas_viewDepth|depthFalloff/,
  );
  assert.doesNotMatch(colorFilter, /\bf_size\b/);
  assert.match(colorFilter, /color = vec4\([^,\n]+, color\.a\)/);
});

test("does not interpolate per-node metadata across a billboard", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const vertexDecl = shaders.inject["vs:#decl"] ?? "";
  const fragmentDecl = shaders.inject["fs:#decl"] ?? "";

  assert.match(vertexDecl, /flat out vec4 atlas_style;/);
  assert.match(fragmentDecl, /flat in vec4 atlas_style;/);
});

test("keeps only unique query-result nodes whose graph positions are available", () => {
  assert.deepEqual(queryHighlightItems(
    [2, 1, 2, -1, 3],
    (rank) => rank === 3 ? null : [rank, rank + 1, rank + 2],
  ), [
    { rank: 2, position: [2, 3, 4] },
    { rank: 1, position: [1, 2, 3] },
  ]);
});

test("dims context only when a query highlight can actually be drawn", () => {
  const previous = {
    selection: state.selection,
    queryResultRanks: state.queryResultRanks,
  };
  try {
    state.selection = null;
    state.queryResultRanks = [4];
    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      posOf: () => null,
    });
    const uniforms = Reflect.get(scene, "atlasUniforms") as () => {
      spotlight: number;
    };
    assert.equal(uniforms.call(scene).spotlight, 0);
    Reflect.set(scene, "posOf", () => [0, 0, 0]);
    assert.equal(uniforms.call(scene).spotlight, 1);
  } finally {
    state.selection = previous.selection;
    state.queryResultRanks = previous.queryResultRanks;
  }
});

test("renders query results as a separate pickable graph layer", () => {
  const queryState = state as typeof state & { queryResultRanks: number[] };
  const previous = queryState.queryResultRanks;
  const picked: number[] = [];
  try {
    queryState.queryResultRanks = [0, 1, 1, 2];
    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      posOf: (rank: number): [number, number, number] | null =>
        rank < 2 ? [rank, 0, 0] : null,
      cb: {
        onHover: () => undefined,
        onPick: (rank: number) => picked.push(rank),
      },
    });
    const buildLayers = Reflect.get(scene, "queryResultLayers") as () => {
      id: string;
      props: Record<string, unknown>;
    }[];
    const layers = buildLayers.call(scene);
    assert.deepEqual(layers.map((layer) => layer.id), [
      "query-results-xray",
      "query-results-lit",
    ]);
    assert.equal(
      (layers[1]?.props.data as { length: number }).length,
      2,
    );
    assert.equal(layers[1]?.props.pickable, true);
    (layers[1]?.props.onClick as (info: { index: number }) => void)({ index: 1 });
    assert.deepEqual(picked, [1]);
  } finally {
    queryState.queryResultRanks = previous;
  }
});

test("keeps query-result markers subtle at overview and prominent through zoom", () => {
  const previous = state.queryResultRanks;
  try {
    state.queryResultRanks = [0];
    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      posOf: (): [number, number, number] => [0, 0, 0],
      cb: {
        onHover: () => undefined,
        onPick: () => undefined,
      },
    });
    const buildLayers = Reflect.get(scene, "queryResultLayers") as () => {
      id: string;
      props: Record<string, unknown>;
    }[];
    const layers = buildLayers.call(scene);
    const layer = (id: string): Record<string, unknown> => {
      const result = layers.find((candidate) => candidate.id === id);
      assert.ok(result);
      return result.props;
    };
    const lit = layer("query-results-lit");
    const xray = layer("query-results-xray");
    const radiusAt = (props: Record<string, unknown>, zoom: number): number =>
      projectedCommonPixels(
        props.getRadius as number,
        zoom,
        props.radiusMinPixels as number,
        props.radiusMaxPixels as number,
      );

    assert.equal(lit.radiusUnits, "common");
    assert.equal(xray.radiusUnits, "common");
    const overviewLit = radiusAt(lit, 0);
    const focusedLit = radiusAt(lit, FOCUS_ZOOM);
    const closerLit = radiusAt(lit, FOCUS_ZOOM + 2);
    assert.ok(overviewLit >= 3);
    assert.ok(overviewLit <= 4);
    assert.ok(radiusAt(xray, 0) <= 6);
    assert.ok(focusedLit > overviewLit);
    assert.ok(closerLit >= focusedLit);
    assert.ok(closerLit <= 12);
    assert.ok(radiusAt(xray, FOCUS_ZOOM + 2) <= 16);
    for (const zoom of [0, FOCUS_ZOOM, FOCUS_ZOOM + 2])
      assert.ok(radiusAt(xray, zoom) > radiusAt(lit, zoom));
  } finally {
    state.queryResultRanks = previous;
  }
});

test("lets working-set nodes grow when zooming in", () => {
  const previousState = {
    selection: state.selection,
    neighbors: state.neighbors,
    neighborLabels: state.neighborLabels,
  };
  const originalWindow = globalThis.window;

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: true }) },
    });
    state.selection = 0;
    state.neighbors = [1];
    state.neighborLabels = ["关联"];

    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      geo: {
        key: new Uint32Array([(1 << 24) | 1, (1 << 24) | 2]),
      },
      wsAnimStart: performance.now(),
      posOf: (rank: number): [number, number, number] => [rank, 0, 0],
      cb: {
        onHover: () => undefined,
        onHoverEdge: () => undefined,
        onPick: () => undefined,
      },
    });
    const buildLayers = Reflect.get(scene, "workingSetLayers") as () => {
      id: string;
      props: Record<string, unknown>;
    }[];
    const layers = buildLayers.call(scene);
    const requireLayer = (id: string): { props: Record<string, unknown> } => {
      const layer = layers.find((candidate) => candidate.id === id);
      assert.ok(layer);
      return layer;
    };
    const lit = requireLayer("ws-lit");
    const xray = requireLayer("ws-xray");
    const covers = requireLayer("ws-covers");

    const assertDoublesWithZoom = (
      value: number,
      minPixels: number,
      maxPixels: number,
    ): void => {
      const atFocus = projectedCommonPixels(
        value,
        FOCUS_ZOOM,
        minPixels,
        maxPixels,
      );
      const oneLevelCloser = projectedCommonPixels(
        value,
        FOCUS_ZOOM + 1,
        minPixels,
        maxPixels,
      );
      assert.ok(Math.abs(oneLevelCloser / atFocus - 2) < 1e-6);
    };
    for (const layer of [lit, xray])
      assertDoublesWithZoom(
        layer.props.getRadius as number,
        layer.props.radiusMinPixels as number,
        layer.props.radiusMaxPixels as number,
      );
    assertDoublesWithZoom(
      covers.props.getSize as number,
      covers.props.sizeMinPixels as number,
      covers.props.sizeMaxPixels as number,
    );
  } finally {
    Object.assign(state, previousState);
    if (originalWindow === undefined)
      Reflect.deleteProperty(globalThis, "window");
    else
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
  }
});
