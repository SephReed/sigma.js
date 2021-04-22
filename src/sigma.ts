/**
 * Sigma.js
 * ========
 * @module
 */
import { EventEmitter } from "events";
import graphExtent from "graphology-metrics/extent";
import { NodeKey, EdgeKey } from "graphology-types";
import Graph from "graphology";
import Camera from "./core/camera";
import MouseCaptor from "./core/captors/mouse";
import QuadTree from "./core/quadtree";
import { Coordinates, EdgeAttributes, Extent, Listener, MouseCoords, NodeAttributes, PlainObject } from "./types";
import {
  createElement,
  getPixelRatio,
  createNormalizationFunction,
  NormalizationFunction,
  assignDeep,
  cancelFrame,
  matrixFromCamera,
  requestFrame,
  validateGraph,
  zIndexOrdering,
} from "./utils";
import { labelsToDisplayFromGrid, edgeLabelsToDisplayFromNodes } from "./core/labels";
import { Settings, DEFAULT_SETTINGS, validateSettings } from "./settings";
import { INodeProgram } from "./rendering/webgl/programs/common/node";
import { IEdgeProgram } from "./rendering/webgl/programs/common/edge";
import TouchCaptor from "./core/captors/touch";

const { nodeExtent, edgeExtent } = graphExtent;

/**
 * Constants.
 */
const PIXEL_RATIO = getPixelRatio();
const WEBGL_OVERSAMPLING_RATIO = getPixelRatio();

/**
 * Important functions.
 */
function applyNodeDefaults(settings: Settings, key: NodeKey, data: NodeAttributes): void {
  if (!data.hasOwnProperty("x") || !data.hasOwnProperty("y"))
    throw new Error(
      `Sigma: could not find a valid position (x, y) for node "${key}". All your nodes must have a number "x" and "y". Maybe your forgot to apply a layout or your "nodeReducer" is not returning the correct data?`,
    );

  if (!data.color) data.color = settings.defaultNodeColor;

  if (!data.label) data.label = "";

  if (!data.size) data.size = 2;

  if (!data.hasOwnProperty("hidden")) data.hidden = false;

  if (!data.hasOwnProperty("highlighted")) data.highlighted = false;
}

function applyEdgeDefaults(settings: Settings, key: EdgeKey, data: EdgeAttributes): void {
  if (!data.color) data.color = settings.defaultEdgeColor;

  if (!data.label) data.label = "";

  if (!data.size) data.size = 0.5;

  if (!data.hasOwnProperty("hidden")) data.hidden = false;
}

/**
 * Main class.
 *
 * @constructor
 * @param {Graph}       graph     - Graph to render.
 * @param {HTMLElement} container - DOM container in which to render.
 * @param {object}      settings  - Optional settings.
 */
export default class Sigma extends EventEmitter {
  settings: Settings;
  graph: Graph;
  mouseCaptor: MouseCaptor;
  touchCaptor: TouchCaptor;
  container: HTMLElement;
  elements: PlainObject<HTMLCanvasElement> = {};
  canvasContexts: PlainObject<CanvasRenderingContext2D> = {};
  webGLContexts: PlainObject<WebGLRenderingContext> = {};
  activeListeners: PlainObject<Listener> = {};
  quadtree: QuadTree = new QuadTree();
  nodeDataCache: Record<NodeKey, Partial<NodeAttributes>> = {};
  edgeDataCache: Record<EdgeKey, Partial<EdgeAttributes>> = {};
  nodeKeyToIndex: Record<NodeKey, number> = {};
  edgeKeyToIndex: Record<EdgeKey, number> = {};
  nodeExtent: { x: Extent; y: Extent; z: Extent } | null = null;
  edgeExtent: { z: Extent } | null = null;

  normalizationFunction: NormalizationFunction | null = null;

  // Starting dimensions
  width = 0;
  height = 0;

  // State
  highlightedNodes: Set<NodeKey> = new Set();
  displayedLabels: Set<NodeKey> = new Set();
  hoveredNode: NodeKey | null = null;
  renderFrame: number | null = null;
  renderHighlightedNodesFrame: number | null = null;
  needToProcess = false;
  needToSoftProcess = false;

  // programs
  nodePrograms: { [key: string]: INodeProgram } = {};
  edgePrograms: { [key: string]: IEdgeProgram } = {};

  camera: Camera;

  constructor(graph: Graph, container: HTMLElement | null, settings: Partial<Settings> = {}) {
    super();

    this.settings = assignDeep<Settings>({}, DEFAULT_SETTINGS, settings);

    // Validating
    validateSettings(this.settings);
    validateGraph(graph);
    if (!(container instanceof HTMLElement)) throw new Error("Sigma: container should be an html element.");

    // Properties
    this.graph = graph;
    this.container = container;

    this.initializeCache();

    // Initializing contexts
    this.createWebGLContext("edges");
    this.createWebGLContext("nodes");
    this.createCanvasContext("edgeLabels");
    this.createCanvasContext("labels");
    this.createCanvasContext("hovers");
    this.createCanvasContext("mouse");

    // Blending
    let gl = this.webGLContexts.nodes;

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    gl = this.webGLContexts.edges;

    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);

    // Loading programs
    for (const type in this.settings.nodeProgramClasses) {
      const NodeProgramClass = this.settings.nodeProgramClasses[type];
      this.nodePrograms[type] = new NodeProgramClass(this.webGLContexts.nodes);
    }
    for (const type in this.settings.edgeProgramClasses) {
      const EdgeProgramClass = this.settings.edgeProgramClasses[type];
      this.edgePrograms[type] = new EdgeProgramClass(this.webGLContexts.edges);
    }

    // Initial resize
    this.resize();

    // Initializing the camera
    this.camera = new Camera();

    // Binding camera events
    this.bindCameraHandlers();

    // Initializing captors
    this.mouseCaptor = new MouseCaptor(this.elements.mouse, this.camera);
    this.touchCaptor = new TouchCaptor(this.elements.mouse, this.camera);

    // Binding event handlers
    this.bindEventHandlers();

    // Binding graph handlers
    this.bindGraphHandlers();

    // Processing data for the first time & render
    this.process();
    this.render();
  }

  /**---------------------------------------------------------------------------
   * Internal methods.
   **---------------------------------------------------------------------------
   */

  /**
   * Internal function used to create a canvas element.
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  createCanvas(id: string): HTMLCanvasElement {
    const canvas: HTMLCanvasElement = createElement<HTMLCanvasElement>(
      "canvas",
      {
        position: "absolute",
      },
      {
        class: `sigma-${id}`,
      },
    );

    this.elements[id] = canvas;
    this.container.appendChild(canvas);

    return canvas;
  }

  /**
   * Internal function used to create a canvas context and add the relevant
   * DOM elements.
   *
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  createCanvasContext(id: string): this {
    const canvas = this.createCanvas(id);

    const contextOptions = {
      preserveDrawingBuffer: false,
      antialias: false,
    };

    this.canvasContexts[id] = canvas.getContext("2d", contextOptions) as CanvasRenderingContext2D;

    return this;
  }

  /**
   * Internal function used to create a canvas context and add the relevant
   * DOM elements.
   *
   * @param  {string} id - Context's id.
   * @return {Sigma}
   */
  createWebGLContext(id: string): this {
    const canvas = this.createCanvas(id);

    const contextOptions = {
      preserveDrawingBuffer: false,
      antialias: false,
    };

    let context;

    // First we try webgl2 for an easy performance boost
    context = canvas.getContext("webgl2", contextOptions);

    // Else we fall back to webgl
    if (!context) context = canvas.getContext("webgl", contextOptions);

    // Edge, I am looking right at you...
    if (!context) context = canvas.getContext("experimental-webgl", contextOptions);

    this.webGLContexts[id] = context as WebGLRenderingContext;

    return this;
  }

  /**
   * Method used to initialize display data cache.
   *
   * @return {Sigma}
   */
  initializeCache(): void {
    const graph = this.graph;

    // NOTE: the data caches are never reset to avoid paying a GC cost
    // But this could prove to be a bad decision. In which case just "reset"
    // them here.

    let i = 0;

    graph.forEachNode((key) => {
      this.nodeKeyToIndex[key] = i++;
      this.nodeDataCache[key] = {};
    });

    i = 0;

    graph.forEachEdge((key) => {
      this.edgeKeyToIndex[key] = i++;
      this.edgeDataCache[key] = {};
    });
  }

  /**
   * Method binding camera handlers.
   *
   * @return {Sigma}
   */
  bindCameraHandlers(): this {
    this.activeListeners.camera = () => {
      this.scheduleRender();
    };

    this.camera.on("updated", this.activeListeners.camera);

    return this;
  }

  /**
   * Method binding event handlers.
   *
   * @return {Sigma}
   */
  bindEventHandlers(): this {
    // Handling window resize
    this.activeListeners.handleResize = () => {
      this.needToSoftProcess = true;
      this.scheduleRender();
    };

    window.addEventListener("resize", this.activeListeners.handleResize);

    // Function checking if the mouse is on the given node
    const mouseIsOnNode = (mouseX: number, mouseY: number, nodeX: number, nodeY: number, size: number): boolean => {
      return (
        mouseX > nodeX - size &&
        mouseX < nodeX + size &&
        mouseY > nodeY - size &&
        mouseY < nodeY + size &&
        Math.sqrt(Math.pow(mouseX - nodeX, 2) + Math.pow(mouseY - nodeY, 2)) < size
      );
    };

    // Function returning the nodes in the mouse's quad
    const getQuadNodes = (mouseX: number, mouseY: number) => {
      const mouseGraphPosition = this.camera.viewportToGraph(this, { x: mouseX, y: mouseY });

      // TODO: minus 1? lol
      return this.quadtree.point(mouseGraphPosition.x, 1 - mouseGraphPosition.y);
    };

    // Handling mouse move
    this.activeListeners.handleMove = (e: Coordinates): void => {
      // NOTE: for the canvas renderer, testing the pixel's alpha should
      // give some boost but this slows things down for WebGL empirically.

      // TODO: this should be a method from the camera (or can be passed to graph to display somehow)
      const sizeRatio = Math.pow(this.camera.getState().ratio, 0.5);

      const quadNodes = getQuadNodes(e.x, e.y);

      // We will hover the node whose center is closest to mouse
      let minDistance = Infinity,
        nodeToHover = null;

      for (let i = 0, l = quadNodes.length; i < l; i++) {
        const node = quadNodes[i];

        const data = this.nodeDataCache[node] as NodeAttributes;

        const pos = this.camera.graphToViewport(this, data);

        const size = data.size / sizeRatio;

        if (mouseIsOnNode(e.x, e.y, pos.x, pos.y, size)) {
          const distance = Math.sqrt(Math.pow(e.x - pos.x, 2) + Math.pow(e.y - pos.y, 2));

          // TODO: sort by min size also for cases where center is the same
          if (distance < minDistance) {
            minDistance = distance;
            nodeToHover = node;
          }
        }
      }

      if (nodeToHover && this.hoveredNode !== nodeToHover) {
        // Handling passing from one node to the other directly
        if (this.hoveredNode) this.emit("leaveNode", { node: this.hoveredNode });

        this.hoveredNode = nodeToHover;
        this.emit("enterNode", { node: nodeToHover });
        this.scheduleHighlightedNodesRender();
        return;
      }

      // Checking if the hovered node is still hovered
      if (this.hoveredNode) {
        const data = this.nodeDataCache[this.hoveredNode] as NodeAttributes;

        const pos = this.camera.graphToViewport(this, data);

        const size = data.size / sizeRatio;

        if (!mouseIsOnNode(e.x, e.y, pos.x, pos.y, size)) {
          const node = this.hoveredNode;
          this.hoveredNode = null;

          this.emit("leaveNode", { node });
          return this.scheduleHighlightedNodesRender();
        }
      }
    };

    // Handling click
    const createClickListener = (eventType: string): ((e: MouseCoords) => void) => {
      return (e) => {
        const sizeRatio = Math.pow(this.camera.getState().ratio, 0.5);

        const quadNodes = getQuadNodes(e.x, e.y);

        for (let i = 0, l = quadNodes.length; i < l; i++) {
          const node = quadNodes[i];

          const data = this.nodeDataCache[node] as NodeAttributes;

          const pos = this.camera.graphToViewport(this, data);

          const size = data.size / sizeRatio;

          if (mouseIsOnNode(e.x, e.y, pos.x, pos.y, size))
            return this.emit(`${eventType}Node`, { node, captor: e, event: e });
        }

        return this.emit(`${eventType}Stage`, { event: e });
      };
    };

    this.activeListeners.handleClick = createClickListener("click");
    this.activeListeners.handleRightClick = createClickListener("rightClick");
    this.activeListeners.handleDown = createClickListener("down");

    this.mouseCaptor.on("mousemove", this.activeListeners.handleMove);
    this.mouseCaptor.on("click", this.activeListeners.handleClick);
    this.mouseCaptor.on("rightClick", this.activeListeners.handleRightClick);
    this.mouseCaptor.on("mousedown", this.activeListeners.handleDown);

    // TODO
    // Deal with Touch captor events

    return this;
  }

  /**
   * Method binding graph handlers
   *
   * @return {Sigma}
   */
  bindGraphHandlers(): this {
    const graph = this.graph;

    this.activeListeners.graphUpdate = () => {
      this.needToProcess = true;
      this.scheduleRender();
    };

    this.activeListeners.softGraphUpdate = () => {
      this.needToSoftProcess = true;
      this.scheduleRender();
    };

    this.activeListeners.addNodeGraphUpdate = (e: { key: NodeKey }): void => {
      // Adding entry to cache
      this.nodeKeyToIndex[e.key] = graph.order - 1;
      this.nodeDataCache[e.key] = {};
      this.activeListeners.graphUpdate();
    };

    this.activeListeners.addEdgeGraphUpdate = (e: { key: EdgeKey }): void => {
      // Adding entry to cache
      this.nodeKeyToIndex[e.key] = graph.order - 1;
      this.edgeDataCache[e.key] = {};
      this.activeListeners.graphUpdate();
    };

    // TODO: clean cache on drop!

    // TODO: bind this on composed state events
    // TODO: it could be possible to update only specific node etc. by holding
    // a fixed-size pool of updated items
    graph.on("nodeAdded", this.activeListeners.addNodeGraphUpdate);
    graph.on("nodeDropped", this.activeListeners.graphUpdate);
    graph.on("nodeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.on("eachNodeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.on("edgeAdded", this.activeListeners.addEdgeGraphUpdate);
    graph.on("edgeDropped", this.activeListeners.graphUpdate);
    graph.on("edgeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.on("eachEdgeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.on("edgesCleared", this.activeListeners.graphUpdate);
    graph.on("cleared", this.activeListeners.graphUpdate);

    return this;
  }

  /**
   * Method used to process the whole graph's data.
   *
   * @return {Sigma}
   */
  process(keepArrays = false): this {
    const graph = this.graph,
      settings = this.settings;

    // Clearing the quad
    this.quadtree.clear();

    // CLear the highlightedNodes
    this.highlightedNodes = new Set();

    // Computing extents
    const nodeExtentProperties = ["x", "y", "z"];

    if (this.settings.zIndex) {
      nodeExtentProperties.push("z");
      // `as any` is a workaround due to g-metrics that is not plugged on the same
      // g-types version
      this.edgeExtent = edgeExtent(graph as any, ["z"]) as { z: Extent };
    }

    // `as any` is a workaround due to g-metrics that is not plugged on the same
    // g-types version
    this.nodeExtent = nodeExtent(graph as any, nodeExtentProperties) as { x: Extent; y: Extent; z: Extent };

    // Rescaling function
    this.normalizationFunction = createNormalizationFunction(this.nodeExtent);

    const nodeProgram = this.nodePrograms[this.settings.defaultNodeType];

    if (!keepArrays) nodeProgram.allocate(graph.order);

    let nodes: NodeKey[] = graph.nodes();

    // Handling node z-index
    // TODO: z-index needs us to compute display data before hand
    if (this.settings.zIndex)
      nodes = zIndexOrdering<NodeKey>(
        this.nodeExtent.z,
        (node: NodeKey): number => graph.getNodeAttribute(node, "z"),
        nodes,
      );

    for (let i = 0, l = nodes.length; i < l; i++) {
      const node = nodes[i];

      // Node display data resolution:
      //   1. First we get the node's attributes
      //   2. We optionally reduce them using the function provided by the user
      //      Note that this function must return a total object and won't be merged
      //   3. We apply our defaults, while running some vital checks
      //   4. We apply the normalization function

      let data = graph.getNodeAttributes(node) as NodeAttributes;

      if (settings.nodeReducer) data = settings.nodeReducer(node, data);

      // We shallow copy the data to avoid mutating both the graph and the reducer's result
      data = Object.assign(this.nodeDataCache[node], data);

      applyNodeDefaults(this.settings, node, data);

      this.normalizationFunction.applyTo(data);

      this.quadtree.add(node, data.x, 1 - data.y, data.size / this.width);

      nodeProgram.process(data, data.hidden, i);

      // Save the node in the highlighted set if needed
      if (data.highlighted === true && !data.hidden) this.highlightedNodes.add(node);

      this.nodeKeyToIndex[node] = i;
    }

    nodeProgram.bufferData();

    const edgeProgram = this.edgePrograms[this.settings.defaultEdgeType];

    if (!keepArrays) edgeProgram.allocate(graph.size);

    let edges: EdgeKey[] = graph.edges();

    // Handling edge z-index
    if (this.settings.zIndex && this.edgeExtent)
      edges = zIndexOrdering(this.edgeExtent.z, (edge: EdgeKey): number => graph.getEdgeAttribute(edge, "z"), edges);

    for (let i = 0, l = edges.length; i < l; i++) {
      const edge = edges[i];

      // Edge display data resolution:
      //   1. First we get the edge's attributes
      //   2. We optionally reduce them using the function provided by the user
      //      Note that this function must return a total object and won't be merged
      //   3. We apply our defaults, while running some vital checks

      let data = graph.getEdgeAttributes(edge) as EdgeAttributes;

      if (settings.edgeReducer) data = settings.edgeReducer(edge, data);

      // We shallow copy the data to avoid mutating both the graph and the reducer's result
      data = Object.assign(this.edgeDataCache[edge], data);

      applyEdgeDefaults(this.settings, edge, data);

      const extremities = graph.extremities(edge),
        sourceData = this.nodeDataCache[extremities[0]] as NodeAttributes,
        targetData = this.nodeDataCache[extremities[1]] as NodeAttributes;

      const hidden = data.hidden || sourceData.hidden || targetData.hidden;
      edgeProgram.process(sourceData, targetData, data, hidden, i);

      this.nodeKeyToIndex[edge] = i;
    }

    // Computing edge indices if necessary
    if (!keepArrays && typeof edgeProgram.computeIndices === "function") edgeProgram.computeIndices();

    edgeProgram.bufferData();

    return this;
  }

  /**---------------------------------------------------------------------------
   * Public API.
   **---------------------------------------------------------------------------
   */

  /**
   * Method returning the renderer's camera.
   *
   * @return {Camera}
   */
  getCamera(): Camera {
    return this.camera;
  }

  /**
   * Method returning the mouse captor.
   *
   * @return {MouseCaptor}
   */
  getMouseCaptor(): MouseCaptor {
    return this.mouseCaptor;
  }

  /**
   * Method returning the touch captor.
   *
   * @return {TouchCaptor}
   */
  getTouchCaptor(): TouchCaptor {
    return this.touchCaptor;
  }

  /**
   * Method used to resize the renderer.
   *
   * @param  {number} width  - Target width.
   * @param  {number} height - Target height.
   * @return {Sigma}
   */
  resize(width?: number, height?: number): this {
    const previousWidth = this.width,
      previousHeight = this.height;

    if (width && height) {
      this.width = width;
      this.height = height;
    } else {
      this.width = this.container.offsetWidth;
      this.height = this.container.offsetHeight;
    }

    if (this.width === 0) throw new Error("Sigma: container has no width.");

    if (this.height === 0) throw new Error("Sigma: container has no height.");

    // If nothing has changed, we can stop right here
    if (previousWidth === this.width && previousHeight === this.height) return this;

    // Sizing dom elements
    for (const id in this.elements) {
      const element = this.elements[id];

      element.style.width = this.width + "px";
      element.style.height = this.height + "px";
    }

    // Sizing canvas contexts
    for (const id in this.canvasContexts) {
      this.elements[id].setAttribute("width", this.width * PIXEL_RATIO + "px");
      this.elements[id].setAttribute("height", this.height * PIXEL_RATIO + "px");

      if (PIXEL_RATIO !== 1) this.canvasContexts[id].scale(PIXEL_RATIO, PIXEL_RATIO);
    }

    // Sizing WebGL contexts
    for (const id in this.webGLContexts) {
      this.elements[id].setAttribute("width", this.width * WEBGL_OVERSAMPLING_RATIO + "px");
      this.elements[id].setAttribute("height", this.height * WEBGL_OVERSAMPLING_RATIO + "px");

      this.webGLContexts[id].viewport(
        0,
        0,
        this.width * WEBGL_OVERSAMPLING_RATIO,
        this.height * WEBGL_OVERSAMPLING_RATIO,
      );
    }

    return this;
  }

  /**
   * Method used to clear the canvases.
   *
   * @return {Sigma}
   */
  clear(): this {
    this.webGLContexts.nodes.clear(this.webGLContexts.nodes.COLOR_BUFFER_BIT);
    this.webGLContexts.edges.clear(this.webGLContexts.edges.COLOR_BUFFER_BIT);
    this.canvasContexts.labels.clearRect(0, 0, this.width, this.height);
    this.canvasContexts.hovers.clearRect(0, 0, this.width, this.height);
    this.canvasContexts.edgeLabels.clearRect(0, 0, this.width, this.height);

    return this;
  }

  /**
   * Method used to render.
   *
   * @return {Sigma}
   */
  render(): this {
    // If a render was scheduled, we cancel it
    if (this.renderFrame) {
      cancelFrame(this.renderFrame);
      this.renderFrame = null;
      this.needToProcess = false;
      this.needToSoftProcess = false;
    }

    // First we need to resize
    this.resize();

    // Clearing the canvases
    this.clear();

    // If we have no nodes we can stop right there
    if (!this.graph.order) return this;

    // TODO: improve this heuristic or move to the captor itself?
    // TODO: deal with the touch captor here as well
    const mouseCaptor = this.mouseCaptor;
    const moving =
      this.camera.isAnimated() ||
      mouseCaptor.isMoving ||
      mouseCaptor.draggedEvents ||
      mouseCaptor.currentWheelDirection;

    // Then we need to extract a matrix from the camera
    const cameraState = this.camera.getState(),
      cameraMatrix = matrixFromCamera(cameraState, {
        width: this.width,
        height: this.height,
      });

    let program;

    // Drawing nodes
    program = this.nodePrograms[this.settings.defaultNodeType];

    program.render({
      matrix: cameraMatrix,
      width: this.width,
      height: this.height,
      ratio: cameraState.ratio,
      nodesPowRatio: 0.5,
      scalingRatio: WEBGL_OVERSAMPLING_RATIO,
    });

    // Drawing edges
    if (!this.settings.hideEdgesOnMove || !moving) {
      program = this.edgePrograms[this.settings.defaultEdgeType];

      program.render({
        matrix: cameraMatrix,
        width: this.width,
        height: this.height,
        ratio: cameraState.ratio,
        edgesPowRatio: 0.5,
        scalingRatio: WEBGL_OVERSAMPLING_RATIO,
      });
    }

    // Do not display labels on move per setting
    if (this.settings.hideLabelsOnMove && moving) return this;

    this.renderLabels();
    this.renderEdgeLabels();
    this.renderHighlightedNodes();

    return this;
  }

  /**
   * Method used to render labels.
   *
   * @return {Sigma}
   */
  renderLabels(): this {
    if (!this.settings.renderLabels) return this;

    const cameraState = this.camera.getState();

    // Finding visible nodes to display their labels
    let visibleNodes: NodeKey[];

    if (cameraState.ratio >= 1) {
      // Camera is unzoomed so no need to ask the quadtree for visible nodes
      visibleNodes = this.graph.nodes();
    } else {
      // Let's ask the quadtree
      const viewRectangle = this.camera.viewRectangle(this);

      visibleNodes = this.quadtree.rectangle(
        viewRectangle.x1,
        1 - viewRectangle.y1,
        viewRectangle.x2,
        1 - viewRectangle.y2,
        viewRectangle.height,
      );
    }

    // Selecting labels to draw
    const gridSettings = this.settings.labelGrid;

    const labelsToDisplay = labelsToDisplayFromGrid({
      cache: this.nodeDataCache as Record<NodeKey, NodeAttributes>,
      camera: this.camera,
      cell: gridSettings.cell,
      dimensions: this,
      displayedLabels: this.displayedLabels,
      fontSize: this.settings.labelSize,
      graph: this.graph,
      renderedSizeThreshold: gridSettings.renderedSizeThreshold,
      visibleNodes,
    });

    // Drawing labels
    const context = this.canvasContexts.labels;

    const sizeRatio = Math.pow(cameraState.ratio, 0.5);

    for (let i = 0, l = labelsToDisplay.length; i < l; i++) {
      const data = this.nodeDataCache[labelsToDisplay[i]] as NodeAttributes;

      const { x, y } = this.camera.graphToViewport(this, data);

      // TODO: we can cache the labels we need to render until the camera's ratio changes
      // TODO: this should be computed in the canvas components?
      const size = data.size / sizeRatio;

      this.settings.labelRenderer(
        context,
        {
          key: labelsToDisplay[i],
          label: data.label,
          color: "#000",
          size,
          x,
          y,
        },
        this.settings,
      );
    }

    // Caching visible nodes and displayed labels
    this.displayedLabels = new Set(labelsToDisplay);

    return this;
  }

  /**
   * Method used to render edge labels, based on which node labels were
   * rendered.
   *
   * @return {Sigma}
   */
  renderEdgeLabels(): this {
    if (!this.settings.renderEdgeLabels) return this;

    const cameraState = this.camera.getState();
    const sizeRatio = Math.pow(cameraState.ratio, 0.5);

    const context = this.canvasContexts.edgeLabels;

    // Clearing
    context.clearRect(0, 0, this.width, this.height);

    const edgeLabelsToDisplay = edgeLabelsToDisplayFromNodes({
      nodeDataCache: this.nodeDataCache as Record<NodeKey, NodeAttributes>,
      edgeDataCache: this.edgeDataCache as Record<NodeKey, EdgeAttributes>,
      graph: this.graph,
      hoveredNode: this.hoveredNode,
      displayedNodeLabels: this.displayedLabels,
      highlightedNodes: this.highlightedNodes,
    });

    for (let i = 0, l = edgeLabelsToDisplay.length; i < l; i++) {
      const edge = edgeLabelsToDisplay[i],
        extremities = this.graph.extremities(edge),
        sourceData = this.nodeDataCache[extremities[0]] as NodeAttributes,
        targetData = this.nodeDataCache[extremities[1]] as NodeAttributes,
        edgeData = this.edgeDataCache[edgeLabelsToDisplay[i]] as EdgeAttributes;

      const { x: sourceX, y: sourceY } = this.camera.graphToViewport(this, sourceData);
      const { x: targetX, y: targetY } = this.camera.graphToViewport(this, targetData);

      // TODO: we can cache the labels we need to render until the camera's ratio changes
      // TODO: this should be computed in the canvas components?
      const size = edgeData.size / sizeRatio;

      this.settings.edgeLabelRenderer(
        context,
        {
          key: edge,
          label: edgeData.label,
          color: edgeData.color,
          size,
        },
        {
          key: extremities[0],
          x: sourceX,
          y: sourceY,
        },
        {
          key: extremities[1],
          x: targetX,
          y: targetY,
        },
        this.settings,
      );
    }

    return this;
  }

  /**
   * Method used to render the highlighted nodes.
   *
   * @return {Sigma}
   */
  renderHighlightedNodes(): void {
    const camera = this.camera;

    const sizeRatio = Math.pow(camera.getState().ratio, 0.5);

    const context = this.canvasContexts.hovers;

    // Clearing
    context.clearRect(0, 0, this.width, this.height);

    // Rendering
    const render = (node: NodeKey): void => {
      const data = this.nodeDataCache[node] as NodeAttributes;

      const { x, y } = camera.graphToViewport(this, data);

      const size = data.size / sizeRatio;

      this.settings.hoverRenderer(
        context,
        {
          key: node,
          label: data.label,
          color: data.color,
          size,
          x,
          y,
        },
        this.settings,
      );
    };

    if (this.hoveredNode) {
      render(this.hoveredNode);
    }

    this.highlightedNodes.forEach(render);
  }

  /**
   * Method used to schedule a render.
   *
   * @return {Sigma}
   */
  scheduleRender(): void {
    // A frame is already scheduled
    if (this.renderFrame) return;

    // Let's schedule a frame
    this.renderFrame = requestFrame(() => {
      // Do we need to process data?
      if (this.needToProcess) {
        this.process();
      } else if (this.needToSoftProcess) {
        this.process(true);
      }

      // Resetting state
      this.renderFrame = null;
      this.needToProcess = false;
      this.needToSoftProcess = false;

      // Rendering
      this.render();
    });
  }

  /**
   * Method used to schedule a hover render.
   *
   */
  scheduleHighlightedNodesRender(): void {
    if (this.renderHighlightedNodesFrame || this.renderFrame) return;

    this.renderHighlightedNodesFrame = requestFrame(() => {
      // Resetting state
      this.renderHighlightedNodesFrame = null;

      // Rendering
      this.renderHighlightedNodes();
      this.renderEdgeLabels();
    });
  }

  /**
   * Method used to manually refresh.
   *
   * @return {Sigma}
   */
  refresh(): this {
    this.needToSoftProcess = true;
    this.scheduleRender();

    return this;
  }

  /**
   * Method used to highlight a node.
   *
   * @param  {string} key - The node's key.
   * @return {Sigma}
   */
  highlightNode(key: NodeKey): this {
    // TODO: check the existence of the node
    // TODO: coerce?
    this.highlightedNodes.add(key);

    // Rendering
    this.scheduleHighlightedNodesRender();

    return this;
  }

  /**
   * Method used to unhighlight a node.
   *
   * @param  {string} key - The node's key.
   * @return {Sigma}
   */
  unhighlightNode(key: NodeKey): this {
    // TODO: check the existence of the node
    // TODO: coerce?
    this.highlightedNodes.delete(key);

    // Rendering
    this.scheduleHighlightedNodesRender();

    return this;
  }

  /**
   * Method used to get all the sigma node attributes.
   * It's usefull for example to get the position of a node
   * and to get values that are set by the nodeReducer
   *
   * @param  {string} key - The node's key.
   * @return {Partial<NodeAttributes>} A copy of the desired node's attribute or undefined if not found
   */
  getNodeAttributes(key: NodeKey): Partial<NodeAttributes> | undefined {
    const node = this.nodeDataCache[key];
    return node ? Object.assign({}, node) : undefined;
  }

  /**
   * Method used to get all the sigma edge attributes.
   * It's usefull for example to get values that are set by the edgeReducer.
   *
   * @param  {string} key - The edge's key.
   * @return {Partial<EdgeAttributes> | undefined} A copy of the desired edge's attribute or undefined if not found
   */
  getEdgeAttributes(key: EdgeKey): Partial<EdgeAttributes> | undefined {
    const edge = this.edgeDataCache[key];
    return edge ? Object.assign({}, edge) : undefined;
  }

  /**
   * Method used to shut the container & release event listeners.
   *
   * @return {undefined}
   */
  kill(): void {
    const graph = this.graph;

    // Emitting "kill" events so that plugins and such can cleanup
    this.emit("kill");

    // Releasing events
    this.removeAllListeners();

    // Releasing camera handlers
    this.camera.removeListener("updated", this.activeListeners.camera);

    // Releasing DOM events & captors
    window.removeEventListener("resize", this.activeListeners.handleResize);
    this.mouseCaptor.kill();
    this.touchCaptor.kill();

    // Releasing graph handlers
    graph.removeListener("nodeAdded", this.activeListeners.addNodeGraphUpdate);
    graph.removeListener("nodeDropped", this.activeListeners.graphUpdate);
    graph.removeListener("nodeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.removeListener("eachNodeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.removeListener("edgeAdded", this.activeListeners.addEdgeGraphUpdate);
    graph.removeListener("edgeDropped", this.activeListeners.graphUpdate);
    graph.removeListener("edgeAttributesUpdated", this.activeListeners.softGraphUpdate);
    graph.removeListener("eachEdgeAttributesUpdated", this.activeListeners.graphUpdate);
    graph.removeListener("edgesCleared", this.activeListeners.graphUpdate);
    graph.removeListener("cleared", this.activeListeners.graphUpdate);

    // Releasing cache & state
    this.quadtree = new QuadTree();
    this.nodeDataCache = {};
    this.edgeDataCache = {};

    this.highlightedNodes = new Set();
    this.displayedLabels = new Set();

    // Clearing frames
    if (this.renderFrame) {
      cancelFrame(this.renderFrame);
      this.renderFrame = null;
    }

    if (this.renderHighlightedNodesFrame) {
      cancelFrame(this.renderHighlightedNodesFrame);
      this.renderHighlightedNodesFrame = null;
    }

    // Destroying canvases
    const container = this.container;

    while (container.firstChild) container.removeChild(container.firstChild);
  }
}