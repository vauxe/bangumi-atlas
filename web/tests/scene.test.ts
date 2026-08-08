import assert from "node:assert/strict";
import { test } from "node:test";

import { NodeStyleExtension, Scene } from "../src/scene";
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
