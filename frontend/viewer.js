// Local WebGL assembly renderer. Poses are the same world deltas used by CAD checks.
import { poseMatrix } from "./src/motion.js";
import { meshBounds } from "./src/meshBounds.js";
import { VIEWS } from "./src/viewCube.js";

const TAU = Math.PI * 2;
const wrap = (a) => a - TAU * Math.round(a / TAU);
const clampPitch = (p) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, p));

export function mountViewer(
  canvas,
  mesh,
  { onRender, onPick, onHover, onCamera, still = false, sharedFrame } = {},
) {
  const gl = canvas.getContext("webgl", { antialias: true, alpha: true });
  if (!gl)
    throw Error(
      "WebGL is unavailable. Download the model or open an SVG view from Files.",
    );
  const reduced = () =>
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  // A shared frame lets two viewers of different versions use the same scale.
  const { center, span } = sharedFrame || meshBounds(mesh);
  const [iy, ip] = VIEWS.iso;
  // Opening move: the camera settles in from a wider, rotated framing.
  const cam =
    still || reduced()
      ? { yaw: iy, pitch: ip, zoom: 1, target: [...center] }
      : { yaw: iy - 0.9, pitch: ip + 0.12, zoom: 0.62, target: [...center] };
  const goal = { yaw: iy, pitch: ip, zoom: 1, target: [...center] };
  const spin = { yaw: 0, pitch: 0 };
  let dragging = null,
    frame = null,
    destroyed = false,
    explodeNow = 0,
    groundNow = still ? 1 : 0;
  let state = {
    explode: 0,
    poses: {},
    offsets: {},
    hidden: [],
    ghosted: [],
    highlight: "",
    selected: "",
    rotate: false,
    background: null,
    printCheck: false,
  };
  // Print check colours: overhang (amber), thin wall (coral), below printable (red).
  const PRINT_COLORS = {
    overhang: [0.98, 0.6, 0.16],
    thin: [0.93, 0.38, 0.32],
    tiny: [0.8, 0.12, 0.22],
  };
  // Light studio clay tones; distinct enough to tell parts apart.
  const palette = [
    [0.8, 0.81, 0.82],
    [0.63, 0.71, 0.6],
    [0.82, 0.76, 0.66],
    [0.6, 0.67, 0.75],
    [0.74, 0.7, 0.78],
    [0.7, 0.77, 0.72],
  ];
  const accent = [0.56, 0.8, 0.2];
  const ROTATE = `vec3 rotate(vec3 w){float c=cos(rotation.x),s=sin(rotation.x),a=cos(rotation.y),b=sin(rotation.y);
    float z1=s*w.x-c*w.y;return vec3(c*w.x+s*w.y,a*w.z-b*z1,b*w.z+a*z1);}`;
  const UNIFORMS = `uniform vec3 center;uniform float span;uniform vec2 rotation;uniform float scale;uniform float aspect;`;
  const project = `vec3 p=rotate((world-center)/span);gl_Position=vec4(p.x*scale/aspect,p.y*scale,-p.z*.08,1.);`;
  const partVertex = `attribute vec3 position;attribute vec3 normal;uniform mat4 model;${UNIFORMS}varying vec3 vNormal;${ROTATE}
    void main(){vec3 world=(model*vec4(position,1.)).xyz;${project}vNormal=rotate(mat3(model)*normal);}`;
  const partFragment = `precision mediump float;varying vec3 vNormal;uniform vec3 color;uniform float alpha;uniform float glow;
    uniform float hover;uniform float picking;
    void main(){if(picking>.5){gl_FragColor=vec4(color,1.);return;}vec3 n=normalize(vNormal);if(!gl_FrontFacing)n=-n;
    vec3 base=mix(color,vec3(${accent.join(",")}),glow*.32)*(1.+hover*.14+glow*.06);
    vec3 sky=vec3(.92,.95,1.),ground=vec3(.34,.33,.31);vec3 hemi=mix(ground,sky,n.y*.5+.5);
    vec3 l=normalize(vec3(-.35,.75,.6));float key=max(dot(n,l),0.);float fill=max(dot(n,normalize(vec3(.7,-.1,.55))),0.);
    float spec=pow(max(dot(n,normalize(l+vec3(0.,0.,1.))),0.),48.)*.22;float rim=pow(1.-abs(n.z),3.);
    vec3 c=base*(hemi*.42+key*.62+fill*.14)+spec+rim*(.07+glow*.22)*mix(vec3(1.),vec3(${accent.join(",")}),glow);
    gl_FragColor=vec4(c*alpha,alpha);}`;
  const derivatives = gl.getExtension("OES_standard_derivatives");
  // One quad for the fading grid, then one soft rounded-rectangle contact
  // shadow per part, blurring and lightening as the part rises off the floor.
  const groundVertex = `attribute vec2 corner;uniform float level;uniform vec2 quadCenter;uniform vec2 quadHalf;${UNIFORMS}
    varying vec2 vWorld;varying float vRadius;${ROTATE}
    void main(){vec3 world=vec3(quadCenter+corner*quadHalf,level);vWorld=world.xy;vRadius=length(corner);${project}}`;
  const groundFragment = `${derivatives ? "#extension GL_OES_standard_derivatives : enable\n#define GRID\n" : ""}precision mediump float;
    varying vec2 vWorld;varying float vRadius;uniform float mode;uniform vec2 footCenter;uniform vec2 footHalf;
    uniform float blur;uniform float strength;uniform float cell;uniform float opacity;
    void main(){if(mode>.5){vec2 q=abs(vWorld-footCenter)-footHalf;float d=length(max(q,0.))+min(max(q.x,q.y),0.);
    float s=(1.-smoothstep(-blur*.6,blur,d))*strength;gl_FragColor=vec4(0.,0.,0.,s*opacity);return;}
    float grid=0.;
    #ifdef GRID
    vec2 g=vWorld/cell;vec2 w=abs(fract(g-.5)-.5)/fwidth(g);grid=(1.-min(min(w.x,w.y),1.))*.09;
    grid*=1.-smoothstep(.2,1.,vRadius);
    #endif
    gl_FragColor=vec4(vec3(grid),grid)*opacity;}`;
  const shaders = [];
  function shader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      gl.deleteShader(s);
      throw Error("Model renderer failed to initialize");
    }
    shaders.push(s);
    return s;
  }
  function link(vertex, fragment, attributeNames, uniformNames) {
    const program = gl.createProgram();
    gl.attachShader(program, shader(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error("Model renderer could not link its shaders");
    return {
      program,
      attributes: attributeNames.map((n) => gl.getAttribLocation(program, n)),
      u: Object.fromEntries(
        ["center", "span", "rotation", "scale", "aspect", ...uniformNames].map(
          (n) => [n, gl.getUniformLocation(program, n)],
        ),
      ),
    };
  }
  const solid = link(
    partVertex,
    partFragment,
    ["position", "normal"],
    ["model", "color", "alpha", "glow", "hover", "picking"],
  );
  const floor = link(
    groundVertex,
    groundFragment,
    ["corner"],
    [
      "level",
      "quadCenter",
      "quadHalf",
      "mode",
      "footCenter",
      "footHalf",
      "blur",
      "strength",
      "cell",
      "opacity",
    ],
  );
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]),
    gl.STATIC_DRAW,
  );
  const lo = [Infinity, Infinity, Infinity],
    hi = [-Infinity, -Infinity, -Infinity];
  const parts = mesh.parts.map((part, index) => {
    const vertices = [],
      plo = [Infinity, Infinity, Infinity],
      phi = [-Infinity, -Infinity, -Infinity];
    for (const v of part.vertices)
      for (let k = 0; k < 3; k++) {
        plo[k] = Math.min(plo[k], v[k]);
        phi[k] = Math.max(phi[k], v[k]);
        lo[k] = Math.min(lo[k], v[k]);
        hi[k] = Math.max(hi[k], v[k]);
      }
    for (const f of part.faces) {
      const p = f.map((i) => part.vertices[i]),
        a = p[1].map((v, i) => v - p[0][i]),
        b = p[2].map((v, i) => v - p[0][i]);
      const n = [
          a[1] * b[2] - a[2] * b[1],
          a[2] * b[0] - a[0] * b[2],
          a[0] * b[1] - a[1] * b[0],
        ],
        l = Math.hypot(...n) || 1;
      for (const v of p) vertices.push(...v, ...n.map((v) => v / l));
    }
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    // Faces flagged by the backend printability screen, one buffer per issue.
    const overlays = [];
    const tiny = new Set(part.print_flags?.tiny || []);
    for (const [key, color] of Object.entries(PRINT_COLORS)) {
      let ids = part.print_flags?.[key] || [];
      if (key === "thin") ids = ids.filter((i) => !tiny.has(i));
      if (!ids.length) continue;
      const data = new Float32Array(ids.length * 18);
      ids.forEach((face, i) =>
        data.set(vertices.slice(face * 18, face * 18 + 18), i * 18),
      );
      const overlay = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, overlay);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      overlays.push({ buffer: overlay, count: ids.length * 3, color });
    }
    const middle = plo.map((v, i) => (v + phi[i]) / 2);
    let direction = middle.map((v, i) => v - center[i]);
    let length = Math.hypot(...direction);
    if (length < span * 0.03) {
      const angle = (index * Math.PI * 2) / mesh.parts.length;
      direction = [Math.cos(angle), Math.sin(angle), 0.5];
      length = Math.hypot(...direction);
    }
    return {
      name: part.name,
      buffer,
      overlays,
      count: vertices.length / 6,
      color: palette[index % palette.length],
      // Picking encodes the part index in the red and green channels.
      id: [((index + 1) & 255) / 255, ((index + 1) >> 8) / 255, 0],
      middle,
      lo: plo,
      half: phi.map((v, i) => (v - plo[i]) / 2),
      radius: Math.hypot(...phi.map((v, i) => v - plo[i])) / 2,
      direction: direction.map((v) => v / length),
      // Displayed opacity and emphasis ease toward their targets.
      fade: 1,
      glow: 0,
      hover: 0,
    };
  });
  // Grid pitch: a round number giving roughly eight cells across the model.
  const gridStep = 10 ** Math.floor(Math.log10(span / 4 || 1));
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  const scaleNow = (aspect) =>
    (1.7 * cam.zoom * Math.min(1, aspect)) / (1 + explodeNow);
  const offsetOf = (part, explode = explodeNow) => {
    const extra = state.offsets[part.name] || [0, 0, 0];
    return part.direction.map((v, i) => v * span * 0.6 * explode + extra[i]);
  };
  function setCamera(program, aspect) {
    gl.useProgram(program.program);
    gl.uniform2f(program.u.rotation, cam.yaw, cam.pitch);
    gl.uniform3fv(program.u.center, cam.target);
    gl.uniform1f(program.u.span, span);
    gl.uniform1f(program.u.aspect, aspect);
    gl.uniform1f(program.u.scale, scaleNow(aspect));
  }
  function drawGround(aspect) {
    // Fade the floor out when looking from below or edge-on.
    const opacity =
      groundNow * Math.min(1, Math.max(0, (cam.pitch + 0.02) / 0.22));
    if (opacity < 0.01) return;
    setCamera(floor, aspect);
    const { u } = floor;
    const level = lo[2] - span * (0.004 + 0.32 * explodeNow);
    gl.uniform1f(u.level, level);
    gl.uniform1f(u.cell, gridStep);
    gl.uniform1f(u.opacity, opacity);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(floor.attributes[0]);
    gl.vertexAttribPointer(floor.attributes[0], 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.uniform1f(u.mode, 0);
    gl.uniform2f(u.quadCenter, center[0], center[1]);
    gl.uniform2f(u.quadHalf, span * 1.3, span * 1.3);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.uniform1f(u.mode, 1);
    for (const part of parts) {
      if (part.fade < 0.01) continue;
      const offset = offsetOf(part),
        lift = state.poses[part.name]?.translation || [0, 0, 0];
      const x = part.middle[0] + offset[0] + lift[0],
        y = part.middle[1] + offset[1] + lift[1];
      const height = Math.max(0, part.lo[2] + offset[2] + lift[2] - level);
      const blur = span * 0.012 + height * 0.45;
      const halfX = Math.max(part.half[0], span * 0.01),
        halfY = Math.max(part.half[1], span * 0.01);
      gl.uniform2f(u.footCenter, x, y);
      gl.uniform2f(u.footHalf, halfX, halfY);
      gl.uniform1f(u.blur, blur);
      gl.uniform1f(
        u.strength,
        0.42 * part.fade * Math.exp(-height / (span * 0.45)),
      );
      gl.uniform2f(u.quadCenter, x, y);
      gl.uniform2f(u.quadHalf, halfX + blur * 1.2, halfY + blur * 1.2);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.disableVertexAttribArray(floor.attributes[0]);
  }
  function drawParts(aspect, picking) {
    setCamera(solid, aspect);
    const { u, attributes } = solid;
    gl.uniform1f(u.picking, picking ? 1 : 0);
    const shown = parts.filter((p) =>
      picking ? !state.hidden.includes(p.name) : p.fade > 0.01,
    );
    // Opaque first, then translucent (ghosted or fading) parts without depth writes.
    const passes = picking
      ? [shown]
      : [
          shown.filter((p) => p.fade > 0.995),
          shown.filter((p) => p.fade <= 0.995),
        ];
    passes.forEach((list, pass) => {
      if (!list.length) return;
      if (pass === 1) {
        // The fragment shader writes premultiplied colour.
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        gl.depthMask(false);
      }
      for (const part of list) {
        gl.bindBuffer(gl.ARRAY_BUFFER, part.buffer);
        attributes.forEach((location, i) => {
          gl.enableVertexAttribArray(location);
          gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, i * 12);
        });
        gl.uniformMatrix4fv(
          u.model,
          false,
          poseMatrix(state.poses[part.name], offsetOf(part)),
        );
        gl.uniform3fv(
          u.color,
          picking
            ? part.id
            : state.printCheck
              ? [0.74, 0.75, 0.76]
              : part.color,
        );
        gl.uniform1f(u.alpha, pass === 1 ? part.fade : 1);
        gl.uniform1f(u.glow, part.glow);
        gl.uniform1f(u.hover, part.hover);
        gl.drawArrays(gl.TRIANGLES, 0, part.count);
      }
      if (pass === 1) {
        gl.disable(gl.BLEND);
        gl.depthMask(true);
      }
    });
    if (state.printCheck && !picking) {
      // Flagged faces are redrawn in place, pulled slightly toward the camera.
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -2);
      for (const part of shown.filter((p) => p.fade > 0.995)) {
        for (const overlay of part.overlays) {
          gl.bindBuffer(gl.ARRAY_BUFFER, overlay.buffer);
          attributes.forEach((location, i) => {
            gl.enableVertexAttribArray(location);
            gl.vertexAttribPointer(location, 3, gl.FLOAT, false, 24, i * 12);
          });
          gl.uniformMatrix4fv(
            u.model,
            false,
            poseMatrix(state.poses[part.name], offsetOf(part)),
          );
          gl.uniform3fv(u.color, overlay.color);
          gl.uniform1f(u.alpha, 1);
          gl.uniform1f(u.glow, 0);
          gl.uniform1f(u.hover, 0);
          gl.drawArrays(gl.TRIANGLES, 0, overlay.count);
        }
      }
      gl.disable(gl.POLYGON_OFFSET_FILL);
    }
    attributes.forEach((location) => gl.disableVertexAttribArray(location));
  }
  let last = 0;
  // Frame-rate independent exponential approach; returns true while still moving.
  function animate(dt) {
    const k = reduced() ? 1 : 1 - Math.exp(-dt * 9);
    let moving = false;
    const approach = (value, to, epsilon) => {
      const d = to - value;
      if (Math.abs(d) <= epsilon) return to;
      moving = true;
      return value + d * k;
    };
    if (!dragging && (spin.yaw || spin.pitch)) {
      // Orbit inertia after a flick: a short glide (at most ~35°), not a spin.
      goal.yaw += spin.yaw * dt;
      goal.pitch = clampPitch(goal.pitch + spin.pitch * dt);
      const decay = Math.exp(-dt * 7);
      spin.yaw = Math.abs(spin.yaw * decay) < 0.01 ? 0 : spin.yaw * decay;
      spin.pitch = Math.abs(spin.pitch * decay) < 0.01 ? 0 : spin.pitch * decay;
      moving = true;
    }
    if (state.rotate && !dragging) {
      goal.yaw += dt * 0.35;
      moving = true;
    }
    cam.yaw = approach(cam.yaw, goal.yaw, 1e-4);
    cam.pitch = approach(cam.pitch, goal.pitch, 1e-4);
    cam.zoom = approach(cam.zoom, goal.zoom, 1e-4);
    for (let i = 0; i < 3; i++)
      cam.target[i] = approach(cam.target[i], goal.target[i], span * 1e-5);
    explodeNow = approach(explodeNow, state.explode, 1e-4);
    groundNow = approach(groundNow, 1, 1e-3);
    for (const part of parts) {
      const fade = state.hidden.includes(part.name)
        ? 0
        : state.ghosted.includes(part.name)
          ? 0.14
          : 1;
      part.fade = approach(part.fade, fade, 1e-3);
      part.glow = approach(
        part.glow,
        part.name === state.selected ? 1 : 0,
        1e-3,
      );
      part.hover = approach(
        part.hover,
        part.name === state.highlight ? 1 : 0,
        1e-3,
      );
    }
    return moving;
  }
  function draw(now) {
    frame = null;
    if (destroyed) return;
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    const moving = animate(dt);
    const rect = canvas.getBoundingClientRect(),
      dpr = Math.min(globalThis.devicePixelRatio || 1, 2),
      aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1);
    const width = Math.max(1, Math.round(rect.width * dpr)),
      height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
    gl.clearColor(...(state.background || [0, 0, 0, 0]));
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawGround(aspect);
    drawParts(aspect, false);
    onRender?.(canvas);
    onCamera?.({
      yaw: cam.yaw,
      pitch: cam.pitch,
      zoom: cam.zoom,
      target: [...cam.target],
    });
    if (moving) refresh();
    else last = 0;
  }
  function refresh() {
    if (!frame && !destroyed) frame = requestAnimationFrame(draw);
  }
  let pickTarget = null;
  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect(),
      width = canvas.width,
      height = canvas.height;
    if (
      !pickTarget ||
      pickTarget.width !== width ||
      pickTarget.height !== height
    ) {
      if (pickTarget) {
        gl.deleteFramebuffer(pickTarget.fb);
        gl.deleteTexture(pickTarget.texture);
        gl.deleteRenderbuffer(pickTarget.depth);
      }
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        width,
        height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      const depth = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
      gl.renderbufferStorage(
        gl.RENDERBUFFER,
        gl.DEPTH_COMPONENT16,
        width,
        height,
      );
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        texture,
        0,
      );
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.DEPTH_ATTACHMENT,
        gl.RENDERBUFFER,
        depth,
      );
      pickTarget = { fb, texture, depth, width, height };
    }
    const x = Math.floor(
        ((clientX - rect.left) / Math.max(rect.width, 1)) * width,
      ),
      y = Math.floor(
        (1 - (clientY - rect.top) / Math.max(rect.height, 1)) * height,
      );
    if (x < 0 || y < 0 || x >= width || y >= height) return "";
    gl.bindFramebuffer(gl.FRAMEBUFFER, pickTarget.fb);
    gl.viewport(0, 0, width, height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    drawParts(Math.max(rect.width, 1) / Math.max(rect.height, 1), true);
    const pixel = new Uint8Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const index = pixel[0] + (pixel[1] << 8) - 1;
    return parts[index]?.name || "";
  }
  let hoverFrame = null,
    hoverAt = null,
    hovered = "";
  const hover = () => {
    hoverFrame = null;
    if (!hoverAt || dragging) return;
    const name = pick(...hoverAt);
    if (name !== hovered) {
      hovered = name;
      state = { ...state, highlight: name };
      refresh();
    }
    onHover?.(name, hoverAt);
  };
  const down = (e) => {
    dragging = {
      x: e.clientX,
      y: e.clientY,
      startX: e.clientX,
      startY: e.clientY,
      time: performance.now(),
      pan: e.shiftKey || e.button === 1 || e.button === 2,
    };
    spin.yaw = spin.pitch = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
  };
  const move = (e) => {
    if (!dragging) {
      if (onPick || onHover) {
        hoverAt = [e.clientX, e.clientY];
        if (!hoverFrame) hoverFrame = requestAnimationFrame(hover);
      }
      return;
    }
    const dx = e.clientX - dragging.x,
      dy = e.clientY - dragging.y;
    if (dragging.pan) panBy(dx, dy);
    else {
      // Drag moves the near side of the model with the pointer.
      const now = performance.now(),
        dt = Math.max(1, now - dragging.time) / 1000;
      cam.yaw = goal.yaw = cam.yaw - dx * 0.009;
      cam.pitch = goal.pitch = clampPitch(cam.pitch + dy * 0.009);
      // Smoothed pointer velocity, so one jittery event doesn't set the glide.
      spin.yaw = spin.yaw * 0.6 + ((-dx * 0.009) / dt) * 0.4;
      spin.pitch = spin.pitch * 0.6 + ((dy * 0.009) / dt) * 0.4;
      dragging.time = now;
    }
    dragging.x = e.clientX;
    dragging.y = e.clientY;
    refresh();
  };
  const up = (e) => {
    if (!dragging) return;
    const click =
      e?.type === "pointerup" &&
      Math.hypot(e.clientX - dragging.startX, e.clientY - dragging.startY) < 5;
    if (click) onPick?.(pick(e.clientX, e.clientY));
    // Only a flick (recent movement) keeps spinning.
    if (
      click ||
      dragging.pan ||
      performance.now() - dragging.time > 80 ||
      reduced()
    )
      spin.yaw = spin.pitch = 0;
    else {
      const limit = 4;
      spin.yaw = Math.max(-limit, Math.min(limit, spin.yaw));
      spin.pitch = Math.max(-limit, Math.min(limit, spin.pitch));
    }
    dragging = null;
    refresh();
  };
  const leave = () => {
    hoverAt = null;
    if (hovered) {
      hovered = "";
      state = { ...state, highlight: "" };
      refresh();
    }
    onHover?.("", null);
  };
  function panBy(dx, dy) {
    // Invert the view rotation so the model follows the pointer.
    const rect = canvas.getBoundingClientRect(),
      aspect = Math.max(rect.width, 1) / Math.max(rect.height, 1),
      scale = scaleNow(aspect);
    const px = ((2 * dx) / Math.max(rect.width, 1)) * (aspect / scale),
      py = (-2 * dy) / Math.max(rect.height, 1) / scale;
    const c = Math.cos(cam.yaw),
      s = Math.sin(cam.yaw),
      a = Math.cos(cam.pitch),
      b = Math.sin(cam.pitch);
    const delta = [c * px - b * s * py, s * px + b * c * py, a * py];
    for (let k = 0; k < 3; k++) {
      cam.target[k] -= delta[k] * span;
      goal.target[k] = cam.target[k];
    }
  }
  const zoomTo = (value) => {
    goal.zoom = Math.min(12, Math.max(0.15, value));
    refresh();
  };
  const wheel = (e) => {
    e.preventDefault();
    // Trackpads send many small deltas; the eased zoom smooths them out.
    zoomTo(goal.zoom * Math.exp(-e.deltaY * 0.0015));
  };
  const dblclick = (e) => {
    const name = pick(e.clientX, e.clientY);
    if (name) api.focus(name);
    else api.fit();
  };
  const key = (e) => {
    const step = {
      ArrowLeft: [0.25, 0],
      ArrowRight: [-0.25, 0],
      ArrowUp: [0, -0.2],
      ArrowDown: [0, 0.2],
    }[e.key];
    if (step) {
      goal.yaw += step[0];
      goal.pitch = clampPitch(goal.pitch + step[1]);
    } else if (["+", "="].includes(e.key))
      goal.zoom = Math.min(12, goal.zoom * 1.2);
    else if (e.key === "-") goal.zoom = Math.max(0.15, goal.zoom / 1.2);
    else if (e.key === "f" || e.key === "F") return api.fit();
    else return;
    e.preventDefault();
    refresh();
  };
  const menu = (e) => e.preventDefault();
  const listeners = [
    ["pointerdown", down],
    ["pointermove", move],
    ["pointerup", up],
    ["pointercancel", up],
    ["lostpointercapture", up],
    ["pointerleave", leave],
    ["contextmenu", menu],
    ["wheel", wheel],
    ["dblclick", dblclick],
    ["keydown", key],
  ];
  for (const [name, fn] of listeners)
    canvas.addEventListener(
      name,
      fn,
      name === "wheel" ? { passive: false } : undefined,
    );
  const observer = new ResizeObserver(refresh);
  observer.observe(canvas);
  refresh();
  const api = {
    update(patch) {
      state = { ...state, ...patch };
      refresh();
    },
    // Mirror another viewer's camera exactly; unchanged values do nothing, so two
    // viewers can follow each other without echoing frames back and forth.
    setCamera({ yaw, pitch, zoom, target }) {
      const same =
        Math.abs(yaw - cam.yaw) < 1e-6 &&
        Math.abs(pitch - cam.pitch) < 1e-6 &&
        Math.abs(zoom - cam.zoom) < 1e-6 &&
        (!target || target.every((v, i) => Math.abs(v - cam.target[i]) < 1e-6));
      if (same) return;
      spin.yaw = spin.pitch = 0;
      cam.yaw = goal.yaw = yaw;
      cam.pitch = goal.pitch = pitch;
      cam.zoom = goal.zoom = zoom;
      if (target)
        for (let k = 0; k < 3; k++) cam.target[k] = goal.target[k] = target[k];
      refresh();
    },
    // Glide to a preset along the shortest turn; framing resets to the whole model.
    view(name) {
      const [yaw, pitch] = VIEWS[name] || VIEWS.iso;
      spin.yaw = spin.pitch = 0;
      goal.yaw = cam.yaw + wrap(yaw - cam.yaw);
      goal.pitch = pitch;
      goal.target = [...center];
      goal.zoom = 1;
      refresh();
    },
    // Relative orbit in pixels, e.g. from dragging the view cube.
    orbitBy(dx, dy) {
      spin.yaw = spin.pitch = 0;
      cam.yaw = goal.yaw = cam.yaw - dx * 0.012;
      cam.pitch = goal.pitch = clampPitch(cam.pitch + dy * 0.012);
      refresh();
    },
    fit() {
      goal.target = [...center];
      goal.zoom = 1;
      refresh();
    },
    zoomBy(factor) {
      zoomTo(goal.zoom * factor);
    },
    // Ease the camera onto one component at its current displayed position.
    focus(name) {
      const part = parts.find((p) => p.name === name);
      if (!part) return api.fit();
      const offset = offsetOf(part, state.explode);
      goal.target = part.middle.map((v, i) => v + offset[i]);
      goal.zoom = Math.min(
        8,
        Math.max(1, (span / Math.max(part.radius * 2, 1e-6)) * 0.7),
      );
      refresh();
    },
    // PNG of the current frame on the studio background.
    snapshot(background = [0.094, 0.094, 0.094, 1]) {
      const previous = state.background;
      state = { ...state, background };
      if (frame) cancelAnimationFrame(frame);
      frame = null;
      draw(performance.now());
      const url = canvas.toDataURL("image/png");
      state = { ...state, background: previous };
      refresh();
      return url;
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      for (const [name, fn] of listeners) canvas.removeEventListener(name, fn);
      for (const p of parts) {
        gl.deleteBuffer(p.buffer);
        p.overlays.forEach((o) => gl.deleteBuffer(o.buffer));
      }
      gl.deleteBuffer(quad);
      if (pickTarget) {
        gl.deleteFramebuffer(pickTarget.fb);
        gl.deleteTexture(pickTarget.texture);
        gl.deleteRenderbuffer(pickTarget.depth);
      }
      gl.deleteProgram(solid.program);
      gl.deleteProgram(floor.program);
      for (const s of shaders) gl.deleteShader(s);
    },
  };
  return api;
}
