import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  CircleCropExtension,
  interactionHint,
  NodeStyleExtension,
  Scene,
  updateQueryResultMask,
} from "../src/scene";
import { FOCUS_ZOOM } from "../src/camera";
import { NEARBY_LABEL_ZOOM } from "../src/labels";
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

test("normalizes landscape and portrait covers before circular cropping", () => {
  const shaders = new CircleCropExtension().getShaders() as {
    inject: Record<string, string>;
    modules?: { name: string; vs: string }[];
  };
  const coverModule = shaders.modules?.find(
    (shaderModule) => shaderModule.name === "circleCrop",
  );
  const vertexStart = shaders.inject["vs:#main-start"] ?? "";
  const sizeFilter = shaders.inject["vs:DECKGL_FILTER_SIZE"] ?? "";
  const vertexEnd = shaders.inject["vs:#main-end"] ?? "";
  const colorFilter = shaders.inject["fs:DECKGL_FILTER_COLOR"] ?? "";

  assert.ok(coverModule);
  assert.match(coverModule.vs, /vec2 circle_crop_frame_size;/);
  assert.match(
    vertexStart,
    /circle_crop_frame_size = instanceIconFrames\.zw;/,
  );
  assert.doesNotMatch(sizeFilter, /instanceIconFrames/);
  assert.match(
    sizeFilter,
    /vec2 coverFrameSize = max\(circle_crop_frame_size, vec2\(1\.0\)\);/,
  );
  assert.match(
    sizeFilter,
    /float coverConstraint = icon\.sizeBasis == 0\.0 \? coverFrameSize\.x : coverFrameSize\.y;/,
  );
  assert.match(sizeFilter, /size\.xy \*= coverConstraint \/ coverFrameSize;/);
  assert.match(
    vertexEnd,
    /float coverSide = min\(coverFrameSize\.x, coverFrameSize\.y\);/,
  );
  assert.match(
    vertexEnd,
    /instanceIconFrames\.xy \+ \(coverFrameSize - vec2\(coverSide\)\) \* 0\.5/,
  );
  assert.match(vertexEnd, /vTextureCoords = mix\(/);
  assert.match(colorFilter, /float cover_r = length\(geometry\.uv\);/);
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
  assert.match(vertexDecl, /flat out float atlas_query_result;/);
  assert.match(fragmentDecl, /flat in float atlas_query_result;/);
});

test("dims only non-result context nodes while a query is highlighted", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const colorFilter = shaders.inject["fs:DECKGL_FILTER_COLOR"] ?? "";

  assert.match(
    colorFilter,
    /if \(atlas\.spotlight > 0\.5 && atlas_query_result < 0\.5\)/,
  );
  assert.match(
    colorFilter,
    /visibility = min\(visibility, 64\.0 \/ 255\.0\);/,
  );
});

test("updates query-result membership without changing other nodes", () => {
  const mask = new Uint8Array(5);

  updateQueryResultMask(mask, new Uint32Array(), Uint32Array.of(1, 3));
  assert.deepEqual([...mask], [0, 255, 0, 255, 0]);

  updateQueryResultMask(mask, Uint32Array.of(1, 3), Uint32Array.of(2, 3, 8));
  assert.deepEqual([...mask], [0, 0, 255, 255, 0]);
});

test("binds query-result membership to every context-node instance", () => {
  const mask = Uint8Array.of(0, 255, 0);
  const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
    styled: 3,
    contextLength: -1,
    contextData: null,
    gpu: null,
    styleBuf: new Uint8Array(12),
    queryResultMask: mask,
    geo: {
      positions: new Float32Array(9),
      size: new Uint8Array(3),
    },
  });
  const build = Reflect.get(scene, "buildContextData") as () => {
    attributes: Record<string, { value?: Uint8Array; type?: string }>;
  };

  const data = build.call(scene);

  assert.equal(data.attributes.getQueryResult?.value, mask);
  assert.equal(data.attributes.getQueryResult?.type, "unorm8");
});

test("dims context only when a query result exists in the context layer", () => {
  const previous = {
    selection: state.selection,
    queryResultRanks: state.queryResultRanks,
  };
  try {
    state.selection = null;
    state.queryResultRanks = Uint32Array.of(4);
    const scene = Object.assign(Object.create(Scene.prototype), {
      styled: 0,
    }) as Scene;
    const uniforms = Reflect.get(scene, "atlasUniforms") as () => {
      spotlight: number;
    };
    assert.equal(uniforms.call(scene).spotlight, 0);
    Reflect.set(scene, "styled", 5);
    assert.equal(uniforms.call(scene).spotlight, 1);
  } finally {
    state.selection = previous.selection;
    state.queryResultRanks = previous.queryResultRanks;
  }
});

test("keeps query results in the base layer without color or outline overlays", () => {
  const previous = state.queryResultRanks;
  let rendered: { id: string; props: Record<string, unknown> }[] = [];
  try {
    state.queryResultRanks = Uint32Array.of(0, 1);
    const scene = Object.assign(Object.create(Scene.prototype), {
      styled: 2,
      queryResultMask: new Uint8Array(2),
      queryResultMaskSource: new Uint32Array(),
      gpu: null,
      contextData: null,
      contextLength: -1,
      buildContextData: () => ({ length: 2, attributes: {} }),
      nearbyLabelLayers: () => [],
      workingSetLayers: () => [],
      anchorFlash: null,
      cb: { onHover: () => undefined },
      deck: {
        setProps: (props: { layers: typeof rendered }) => {
          rendered = props.layers;
        },
      },
    }) as Scene;
    scene.render();

    assert.deepEqual(rendered.map((layer) => layer.id), ["context"]);
    assert.equal(rendered[0]?.props.pickable, true);
    assert.deepEqual(
      [...(Reflect.get(scene, "queryResultMask") as Uint8Array)],
      [255, 255],
    );
  } finally {
    state.queryResultRanks = previous;
  }
});

test("loads and draws nearby names only while no working set is selected", async () => {
  const previousSelection = state.selection;
  const loaded: number[][] = [];
  try {
    state.selection = null;
    const viewport = {
      width: 1_000,
      height: 600,
      focalDistance: 1,
      viewProjectionMatrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      project: (position: [number, number, number]) => [
        position[0] * 100 + 200,
        position[1] * 100 + 200,
      ],
    };
    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      geo: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, -3, 0, 0]),
        loaded: 3,
      },
      camera: {
        viewState: {
          target: [0, 0, 0],
          zoom: NEARBY_LABEL_ZOOM,
          rotationX: 25,
          rotationOrbit: 0,
        },
      },
      deck: { getViewports: () => [viewport] },
      cb: {
        nameOf: (rank: number) => rank === 0 ? "近节点" : null,
        loadNames: async (ranks: number[]) => {
          loaded.push([...ranks]);
        },
      },
      nearbyRanks: [],
      labelNamesPending: false,
      render: () => undefined,
    });
    const refresh = Reflect.get(scene, "refreshNearbyLabels") as () => void;
    refresh.call(scene);
    // rank 2 在三维近邻半径内，但投影到视口左侧；它不应占用候选预算
    // 或触发名字块请求。
    assert.deepEqual(Reflect.get(scene, "nearbyRanks"), [0, 1]);

    const buildLayers = Reflect.get(scene, "nearbyLabelLayers") as () => {
      id: string;
    }[];
    assert.deepEqual(buildLayers.call(scene).map((layer) => layer.id), [
      "nearby-node-names",
    ]);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(loaded, [[1]]);

    state.selection = 0;
    assert.deepEqual(buildLayers.call(scene), []);
  } finally {
    state.selection = previousSelection;
  }
});

test("loads the latest name batch after an in-flight request settles", async () => {
  const loads: number[][] = [];
  const completions: Array<() => void> = [];
  let renders = 0;
  const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
    cb: {
      loadNames: (ranks: number[]) => new Promise<void>((resolve) => {
        loads.push([...ranks]);
        completions.push(resolve);
      }),
    },
    labelNamesPending: false,
    queuedLabelRanks: null,
    render: () => {
      renders++;
    },
  });
  const request = Reflect.get(scene, "requestLabelNames") as (
    ranks: number[],
  ) => void;

  request.call(scene, [1]);
  request.call(scene, [2]);
  request.call(scene, [3]);
  assert.deepEqual(loads, [[1]]);

  completions.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(loads, [[1], [3]]);
  assert.equal(renders, 0);

  completions.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(renders, 1);
  assert.equal(Reflect.get(scene, "labelNamesPending"), false);
});

test("rebuilds nearby label layout after a resize with the same ranks", () => {
  const previousSelection = state.selection;
  const renderedWidths: number[] = [];
  try {
    state.selection = null;
    const viewport = {
      width: 1_000,
      height: 600,
      focalDistance: 1,
      viewProjectionMatrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      project: () => [200, 200],
    };
    const scene = Object.assign(Object.create(Scene.prototype) as Scene, {
      geo: {
        positions: new Float32Array([0, 0, 0]),
        loaded: 1,
      },
      camera: {
        viewState: {
          target: [0, 0, 0],
          zoom: NEARBY_LABEL_ZOOM,
          rotationX: 25,
          rotationOrbit: 0,
        },
      },
      deck: { getViewports: () => [viewport] },
      nearbyRanks: [],
      render: () => renderedWidths.push(viewport.width),
    });
    const refresh = Reflect.get(scene, "refreshNearbyLabels") as () => void;

    refresh.call(scene);
    viewport.width = 800;
    refresh.call(scene);

    assert.deepEqual(Reflect.get(scene, "nearbyRanks"), [0]);
    assert.deepEqual(renderedWidths, [1_000, 800]);
  } finally {
    state.selection = previousSelection;
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
