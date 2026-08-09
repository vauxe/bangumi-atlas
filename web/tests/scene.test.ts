import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeStyleExtension, queryHighlightItems, Scene } from "../src/scene";
import { FOCUS_ZOOM } from "../src/camera";
import type { OrbitState } from "../src/camera";
import { state } from "../src/store";

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

    const projectedCommonPixels = (
      value: number,
      zoom: number,
      minPixels: number,
      maxPixels: number,
    ): number => Math.min(Math.max(value * 2 ** zoom, minPixels), maxPixels);
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
