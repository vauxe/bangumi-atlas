import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EDGE_WIDTHS,
  NodeStyleExtension,
  Scene,
} from "../src/scene";
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
    scheduleEdgeRebuild: () => events.push("edges"),
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
  assert.deepEqual(events, ["state", "view", "deck", "edges", "layers"]);
});

test("keeps node connections visually subordinate to nodes", () => {
  assert.ok(EDGE_WIDTHS.context <= 0.5);
  assert.ok(EDGE_WIDTHS.relation <= 1);
  assert.ok(EDGE_WIDTHS.path <= 1.5);
  assert.ok(EDGE_WIDTHS.context < EDGE_WIDTHS.relation);
  assert.ok(EDGE_WIDTHS.relation < EDGE_WIDTHS.path);
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

test("keeps normal node colors full-strength and zoom-independent", () => {
  const shaders = new NodeStyleExtension().getShaders() as {
    inject: Record<string, string>;
  };
  const colorFilter = shaders.inject["fs:DECKGL_FILTER_COLOR"] ?? "";
  const nodeShaders = Object.values(shaders.inject).join("\n");

  assert.doesNotMatch(
    nodeShaders,
    /atlas\.zoom|atlas_reveal|atlas_keep|atlas_viewDepth|depthFalloff/,
  );
  assert.doesNotMatch(colorFilter, /float f_size|160\.0|floor\(f_size/);
  assert.match(colorFilter, /float visibility = a_iso \? 150\.0 \/ 255\.0 : 1\.0/);
  assert.match(
    colorFilter,
    /vec3 stableRgb = mix\(vec3\(15\.0, 26\.0, 28\.0\), rgb, visibility\)/,
  );
  assert.match(colorFilter, /color = vec4\(stableRgb \/ 255\.0, color\.a\)/);
  assert.doesNotMatch(colorFilter, /\(a \/ 255\.0\) \* color\.a/);
});

test("excludes subjects with unknown years when a year filter is active", () => {
  const previousFilters = state.filters;
  const scene = Object.assign(Object.create(Scene.prototype), {
    geo: {
      key: new Uint32Array([(1 << 24) | 1]),
      year: new Uint16Array([0]),
      score: new Uint8Array([0]),
      tags: new Uint32Array([0]),
    },
  }) as unknown as Scene;

  try {
    state.filters = {
      yearMin: 2000,
      yearMax: 2020,
      media: new Set(),
      scoreMin: 0,
      tags: new Set(),
    };
    assert.equal(scene.isVisible(0), false);

    state.filters = { ...state.filters, yearMin: 0, yearMax: 9999 };
    assert.equal(scene.isVisible(0), true);
  } finally {
    state.filters = previousFilters;
  }
});

test("keeps working-set nodes at their focus size and lets them grow when zooming in", () => {
  const previousState = {
    selection: state.selection,
    neighbors: state.neighbors,
    neighborLabels: state.neighborLabels,
    compareWith: state.compareWith,
    path: state.path,
    pathLabels: state.pathLabels,
  };
  const originalWindow = globalThis.window;

  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { matchMedia: () => ({ matches: true }) },
    });
    state.selection = 0;
    state.neighbors = [1];
    state.neighborLabels = [0];
    state.compareWith = null;
    state.path = [];
    state.pathLabels = [];

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
    const assertCircleKeepsGrowing = (props: Record<string, unknown>): void => {
      const atFocus = projectedCommonPixels(
        props.getRadius as number,
        FOCUS_ZOOM,
        props.radiusMinPixels as number,
        props.radiusMaxPixels as number,
      );
      const oneLevelCloser = projectedCommonPixels(
        props.getRadius as number,
        FOCUS_ZOOM + 1,
        props.radiusMinPixels as number,
        props.radiusMaxPixels as number,
      );
      assert.ok(Math.abs(atFocus - 9) < 1e-6);
      assert.ok(Math.abs(oneLevelCloser / atFocus - 2) < 1e-6);
    };
    assertCircleKeepsGrowing(lit.props);
    assertCircleKeepsGrowing(xray.props);

    const coverAtFocus = projectedCommonPixels(
      covers.props.getSize as number,
      FOCUS_ZOOM,
      covers.props.sizeMinPixels as number,
      covers.props.sizeMaxPixels as number,
    );
    const coverOneLevelCloser = projectedCommonPixels(
      covers.props.getSize as number,
      FOCUS_ZOOM + 1,
      covers.props.sizeMinPixels as number,
      covers.props.sizeMaxPixels as number,
    );

    assert.ok(Math.abs(coverAtFocus - 16.5) < 1e-6);
    assert.ok(Math.abs(coverOneLevelCloser / coverAtFocus - 2) < 1e-6);
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
