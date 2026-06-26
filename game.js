// RIO MOST WANTED — Linha Amarela
// Corrida arcade estilo NFS Most Wanted (PS2) sobre vias reais do Rio (OSM).
// v5: malha bidirecional com 3 terminais (Recreio, Jardim Oceânico, Fundão),
// 6 rotas direcionais, elevação real de pontes/alças (corrige overlaps).
import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';

window.__GAME_OK__ = true;

// Versão do JOGO (mecânica). BUMPAR a cada mudança de funcionamento que afete
// os tempos — isso reseta todos os leaderboards e ghosts automaticamente
// (a versão faz parte da chave de armazenamento; chaves de versões antigas
// são apagadas no boot). Também é o que aparece no rodapé do menu.
const GAME_VERSION = 'POL-9.4';
{
  const tag = document.getElementById('buildtag');
  if (tag) tag.textContent = 'build ' + GAME_VERSION;
  // limpa leaderboards/ghosts de versões anteriores (mecânica mudou)
  for (const key of Object.keys(localStorage))
    if ((key.startsWith('rmw_lb') || key.startsWith('rmw_ghost')) &&
        !key.includes('::v' + GAME_VERSION + '::'))
      localStorage.removeItem(key);
}

// ================================================================ rotas
const DECK = 6.0; // altura de viadutos/alças

function buildRouteData(rd) {
  // densifica a polilinha para segmentos <= 25 m
  const src = rd.pts;
  const pts = [];
  for (let i = 0; i < src.length - 1; i++) {
    const [ax, az, at, aln, abr, aonc] = src[i], [bx, bz, bt] = src[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / 25));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      pts.push({ x: ax + (bx - ax) * t, z: az + (bz - az) * t,
                 tun: at && bt ? 1 : (k > 0 ? (at || bt) : at),
                 ln: aln || 3, br: abr || 0, onc: aonc || 0 });
    }
  }
  const last = src[src.length - 1];
  pts.push({ x: last[0], z: last[1], tun: last[2], ln: last[3] || 3,
             br: last[4] || 0, onc: last[5] || 0 });
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  // largura real: faixas próprias + contramão (mão dupla colada), taper suave
  const rawHalf = pts.map(p => (p.ln + p.onc) * 1.8 + 0.6);
  for (const p of pts) p.ownOff = p.onc * 1.8; // centro do lado próprio
  for (let i = 0; i < pts.length; i++) {
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(pts.length - 1, i + 3); k++) { sum += rawHalf[k]; cnt++; }
    pts[i].half = sum / cnt;
    // o rail visível fica em half+0.8; carro (meia-largura ~0.93) encosta nele
    pts[i].wall = pts[i].half - 0.1;
  }
  // elevação: pontes/alças sobem a DECK com rampas suaves (corrige a pista
  // cruzando sobre si mesma no mesmo plano)
  let ys = pts.map(p => (p.br && !p.tun) ? DECK : 0);
  for (let pass = 0; pass < 10; pass++) {
    const ny = ys.slice();
    for (let i = 1; i < ys.length - 1; i++)
      ny[i] = ys[i - 1] * 0.25 + ys[i] * 0.5 + ys[i + 1] * 0.25;
    ys = ny;
  }
  for (let i = 0; i < pts.length; i++) pts[i].y = ys[i];
  // normais por ponto (mitra) para deslocamentos laterais
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(pts.length - 1, i + 1)];
    let dx = p1.x - p0.x, dz = p1.z - p0.z;
    const L = Math.hypot(dx, dz) || 1;
    pts[i].nx = -dz / L; pts[i].nz = dx / L; // aponta para a direita
  }
  // perfil de pilotagem ideal: velocidade máxima por curvatura (vcurve) e o
  // teto de aproximação com frenagem antecipada (vapp) — usado pela polícia
  // (piloto perfeito) e pela calibração do contra-relógio
  const BRAKE = 22; // m/s^2 de frenagem do piloto ideal
  for (let i = 0; i < pts.length; i++) {
    let R = 5000;
    if (i > 0 && i < pts.length - 1) {
      const h1 = Math.atan2(pts[i + 1].x - pts[i].x, pts[i + 1].z - pts[i].z);
      const h0 = Math.atan2(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      let dh = Math.abs(h1 - h0);
      if (dh > Math.PI) dh = 2 * Math.PI - dh;
      const ds = (cum[i + 1] - cum[i - 1]) / 2;
      R = Math.max(8, ds / Math.max(1e-4, dh));
    }
    pts[i].vcurve = Math.sqrt(13 * R); // aderência lateral ~1.3g
  }
  pts[pts.length - 1].vapp = pts[pts.length - 1].vcurve;
  for (let i = pts.length - 2; i >= 0; i--) {
    const ds = cum[i + 1] - cum[i];
    pts[i].vapp = Math.min(pts[i].vcurve,
      Math.sqrt(pts[i + 1].vapp * pts[i + 1].vapp + 2 * BRAKE * ds));
  }
  return { pts, cum, total: cum[cum.length - 1],
           from: rd.from, to: rd.to, exits: rd.exits || [],
           tunnels: rd.tunnels || [], toll: rd.toll || null };
}

const ROUTES = MAP_DATA.routes.map(buildRouteData);
let ROUTE = ROUTES[0]; // rota ativa (selecionada no menu)

function offsetRoute(i, off) {
  const p = ROUTE.pts[i];
  return [p.x + p.nx * off, p.z + p.nz * off];
}

function routeSample(s) {
  s = Math.max(0, Math.min(ROUTE.total - 0.01, s));
  let lo = 0, hi = ROUTE.cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (ROUTE.cum[m] <= s) lo = m; else hi = m; }
  const a = ROUTE.pts[lo], b = ROUTE.pts[lo + 1];
  const seg = ROUTE.cum[lo + 1] - ROUTE.cum[lo];
  const t = seg > 0 ? (s - ROUTE.cum[lo]) / seg : 0;
  let dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
           y: a.y + (b.y - a.y) * t, dx, dz, tun: a.tun, idx: lo };
}

// ponto mais próximo na rota (busca local; penaliza saltos de índice para
// não pular para o ramo errado onde a rota cruza perto de si mesma)
function routeClosest(px, pz, hint) {
  const P = ROUTE.pts, n = P.length;
  let best = { d2: 1e18, cost: 1e18 };
  const lo = Math.max(0, hint - 14), hi = Math.min(n - 2, hint + 14);
  for (let i = lo; i <= hi; i++) {
    const ax = P[i].x, az = P[i].z, bx = P[i + 1].x, bz = P[i + 1].z;
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + dx * t, qz = az + dz * t;
    const d2 = (px - qx) * (px - qx) + (pz - qz) * (pz - qz);
    const salto = Math.max(0, Math.abs(i - hint) - 8);
    const cost = d2 + salto * salto * 9;
    if (cost < best.cost) {
      const L = Math.sqrt(L2) || 1;
      best = { d2, cost, idx: i, t, s: ROUTE.cum[i] + L * t,
               dx: dx / L, dz: dz / L, qx, qz,
               y: P[i].y + (P[i + 1].y - P[i].y) * t };
    }
  }
  const rX = -best.dz, rZ = best.dx;
  best.lat = (px - best.qx) * rX + (pz - best.qz) * rZ;
  best.rX = rX; best.rZ = rZ;
  return best;
}

// células ocupadas por qualquer rota (veta pilares de viaduto sobre as pistas)
const ROUTE_CELL = 16;
const routeCells = new Set();
for (const R of ROUTES)
  for (const p of R.pts)
    for (let ox = -2; ox <= 2; ox++) for (let oz = -2; oz <= 2; oz++)
      routeCells.add((((p.x / ROUTE_CELL) | 0) + ox) + ',' + (((p.z / ROUTE_CELL) | 0) + oz));
const nearPlayedRoute = (x, z) =>
  routeCells.has(((x / ROUTE_CELL) | 0) + ',' + ((z / ROUTE_CELL) | 0));

// grade fina das rotas: suprime fitas de viaduto do entorno que duplicam a
// própria rota elevada ("teto cinza fantasma" sobre as rampas)
const FINE_CELL = 9;
const fineCells = new Set();
for (const R of ROUTES)
  for (let i = 0; i < R.pts.length - 1; i++) {
    const a = R.pts[i], b = R.pts[i + 1];
    const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 6));
    for (let k = 0; k <= n; k++) {
      const x = a.x + (b.x - a.x) * k / n, z = a.z + (b.z - a.z) * k / n;
      fineCells.add(((x / FINE_CELL) | 0) + ',' + ((z / FINE_CELL) | 0));
    }
  }
function nearRouteFine(x, z) {
  const cx = (x / FINE_CELL) | 0, cz = (z / FINE_CELL) | 0;
  for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++)
    if (fineCells.has((cx + ox) + ',' + (cz + oz))) return true;
  return false;
}

// ================================================================ cena
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game'), antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.6));
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc6b894);
scene.fog = new THREE.Fog(0xc6b894, 280, 2900);
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 9000);

scene.add(new THREE.HemisphereLight(0xd8cfae, 0x4a4a3a, 0.95));
const sun = new THREE.DirectionalLight(0xfff0d0, 1.5);
sun.position.set(400, 600, -250);
scene.add(sun);

{
  const g = new THREE.Mesh(
    new THREE.PlaneGeometry(80000, 80000),
    new THREE.MeshLambertMaterial({ color: 0x565a48 }));
  g.rotation.x = -Math.PI / 2; g.position.y = -0.05;
  scene.add(g);
}

// ------------------------------------------------- geometria utilitária
function makeMergedMesh(pos, col, nrm, material) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return new THREE.Mesh(geo, material);
}

function ribbonInto(pos, col, nrm, pts, width, y, r, g, b) {
  // fita plana com juntas em mitra; y: número ou array por ponto
  const n = pts.length;
  if (n < 2) return;
  const half = width / 2;
  const yAt = i => Array.isArray(y) ? y[i] : y;
  const L = [], R = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let d0x = 0, d0z = 0, d1x = 0, d1z = 0;
    if (i > 0) { d0x = p[0] - pts[i - 1][0]; d0z = p[1] - pts[i - 1][1]; }
    if (i < n - 1) { d1x = pts[i + 1][0] - p[0]; d1z = pts[i + 1][1] - p[1]; }
    let mx = d0x + d1x, mz = d0z + d1z;
    const ml = Math.hypot(mx, mz) || 1; mx /= ml; mz /= ml;
    const l1 = Math.hypot(d1x, d1z) || Math.hypot(d0x, d0z) || 1;
    const ux = (i < n - 1 ? d1x : d0x) / l1, uz = (i < n - 1 ? d1z : d0z) / l1;
    const pxv = -mz, pzv = mx;
    const dot = Math.max(0.45, pxv * -uz + pzv * ux);
    const w = half / dot;
    L.push([p[0] - pxv * w, p[1] - pzv * w]);
    R.push([p[0] + pxv * w, p[1] + pzv * w]);
  }
  for (let i = 0; i < n - 1; i++) {
    const yA = yAt(i), yB = yAt(i + 1);
    pos.push(L[i][0], yA, L[i][1], R[i][0], yA, R[i][1], R[i + 1][0], yB, R[i + 1][1],
             L[i][0], yA, L[i][1], R[i + 1][0], yB, R[i + 1][1], L[i + 1][0], yB, L[i + 1][1]);
    for (let k = 0; k < 6; k++) { col.push(r, g, b); nrm.push(0, 1, 0); }
  }
}

// ------------------------------------------------- vias do entorno (fixas)
{
  const STYLE = {
    la: { w: 13.0, y: 0.045 }, mw: { w: 14.0, y: 0.030 }, tr: { w: 11.0, y: 0.026 },
    pr: { w: 8.5, y: 0.020 }, lk: { w: 6.5, y: 0.036 },
  };
  const ASF = [0.31, 0.31, 0.34];
  const pos = [], col = [], nrm = [];
  for (const rd of MAP_DATA.roads) {
    const st = STYLE[rd.t];
    const j = (Math.random() - 0.5) * 0.015;
    const y = rd.b ? DECK + Math.random() * 0.05 : st.y + Math.random() * 0.006;
    // desenha a fita PULANDO os trechos colados a qualquer rota jogável: senão a
    // via (Linha Amarela, motorways, pista contrária) aparece duplicada por cima
    // do corredor — o leque de "pistas erradas" e a defensa com asfalto dos dois
    // lados ("parede no meio da pista"). Vale p/ viaduto (teto fantasma) e plana.
    {
      let run = [];
      const flush = () => {
        if (run.length >= 2)
          ribbonInto(pos, col, nrm, run, st.w, y, ASF[0] + j, ASF[1] + j, ASF[2] + j);
        run = [];
      };
      for (let i = 0; i < rd.p.length; i++) {
        const [px, pz] = rd.p[i];
        if (nearRouteFine(px, pz)) flush();
        else run.push(rd.p[i]);
      }
      flush();
    }
    if (rd.b) {
      let acc = 0;
      for (let i = 0; i < rd.p.length - 1; i++) {
        const [ax, az] = rd.p[i], [bx, bz] = rd.p[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        let dEdge = 45 - acc;
        while (dEdge < L) {
          const t = dEdge / L;
          const px = ax + (bx - ax) * t, pz = az + (bz - az) * t;
          if (!nearPlayedRoute(px, pz)) { // sem pilar fantasma nas pistas
            for (const [ox, oz] of [[0.7, 0], [0, 0.7]]) {
              pos.push(px - ox, 0, pz - oz, px + ox, 0, pz + oz, px + ox, y, pz + oz,
                       px - ox, 0, pz - oz, px + ox, y, pz + oz, px - ox, y, pz - oz);
              for (let k = 0; k < 6; k++) { col.push(0.34, 0.33, 0.32); nrm.push(0, 1, 0); }
            }
          }
          dEdge += 45;
        }
        acc = (acc + L) % 45;
      }
    }
  }
  scene.add(makeMergedMesh(pos, col, nrm,
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
}

// ------------------------------------------------- praia (orla Recreio–Jd. Oceânico)
// indo do Recreio para o Jardim Oceânico (leste), o mar fica à direita (sul)
let onBeach = () => false;
{
  const R = ROUTES.find(r => r.from === 'Recreio' && r.to === 'Jardim Oceânico');
  if (R) {
    const pos = [], col = [], nrm = [];
    const cells = new Set();
    const BC = 20;
    const off = (i, o) => [R.pts[i].x + R.pts[i].nx * o, R.pts[i].z + R.pts[i].nz * o];
    // trechos costeiros: via apontando para leste (a orla corre L-O)
    const runs = [];
    let run = null;
    for (let i = 0; i < R.pts.length - 1; i++) {
      const a = R.pts[i], b = R.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      const coastal = dx / L > 0.45 && R.cum[i] > 300 && R.cum[i] < R.total - 300;
      if (coastal) { if (!run) run = [i, i + 1]; run[1] = i + 1; }
      else if (run) { runs.push(run); run = null; }
    }
    if (run) runs.push(run);

    let palmAcc = 0;
    for (const [i0, i1] of runs) {
      if (R.cum[i1] - R.cum[i0] < 250) continue;
      for (let i = i0; i < i1; i++) {
        // faixas: areia 12–78 m, espuma 78–86 m, mar 86–950 m
        const bands = [
          [12, 78, [0.84, 0.77, 0.58], 0.012],
          [78, 86, [0.93, 0.93, 0.88], 0.010],
          [86, 950, [0.16, 0.40, 0.44], 0.008],
        ];
        for (const [o1, o2, c2, y] of bands) {
          const a1 = off(i, o1), a2 = off(i, o2);
          const b1 = off(i + 1, o1), b2 = off(i + 1, o2);
          pos.push(a1[0], y, a1[1], a2[0], y, a2[1], b2[0], y, b2[1],
                   a1[0], y, a1[1], b2[0], y, b2[1], b1[0], y, b1[1]);
          for (let k = 0; k < 6; k++) { col.push(c2[0], c2[1], c2[2]); nrm.push(0, 1, 0); }
        }
        // nada de prédios na areia/mar
        for (let o = 8; o <= 130; o += 18) {
          const [x, z] = off(i, o);
          cells.add(((x / BC) | 0) + ',' + ((z / BC) | 0));
        }
        // coqueiros no calçadão a cada ~70 m
        palmAcc += R.cum[i + 1] - R.cum[i];
        if (palmAcc > 70) {
          palmAcc = 0;
          const [px, pz] = off(i, 9.8);
          for (const [ox, oz] of [[0.16, 0], [0, 0.16]]) {
            pos.push(px - ox, 0, pz - oz, px + ox, 0, pz + oz, px + ox, 3.1, pz + oz,
                     px - ox, 0, pz - oz, px + ox, 3.1, pz + oz, px - ox, 3.1, pz - oz);
            for (let k = 0; k < 6; k++) { col.push(0.42, 0.33, 0.22); nrm.push(0, 1, 0); }
          }
          for (const [ox, oz] of [[1.5, 0], [0, 1.5]]) {
            pos.push(px - ox, 2.9, pz - oz, px + ox, 2.9, pz + oz, px, 4.3, pz,
                     px - ox, 2.9, pz - oz, px, 4.3, pz, px - ox, 2.9, pz - oz);
            for (let k = 0; k < 6; k++) { col.push(0.18, 0.42, 0.20); nrm.push(0, 1, 0); }
          }
        }
      }
    }
    scene.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    onBeach = (x, z) => {
      const cx = (x / BC) | 0, cz = (z / BC) | 0;
      for (let ox = -1; ox <= 1; ox++) for (let oz = -1; oz <= 1; oz++)
        if (cells.has((cx + ox) + ',' + (cz + oz))) return true;
      return false;
    };
  }
}

// ------------------------------------------------- prédios procedurais
{
  const cv = document.createElement('canvas'); cv.width = cv.height = 96;
  const cx2 = cv.getContext('2d');
  cx2.fillStyle = '#c9c9c4'; cx2.fillRect(0, 0, 96, 96);
  for (let yy = 8; yy < 96; yy += 12)
    for (let xx = 8; xx < 96; xx += 12) {
      cx2.fillStyle = Math.random() < 0.18 ? '#aebdc8' : '#535e6b';
      cx2.fillRect(xx, yy, 6, 7);
    }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;

  const CELL = 22, occ = new Set();
  const mark = (x, z) => occ.add(((x / CELL) | 0) + ',' + ((z / CELL) | 0));
  for (const rd of MAP_DATA.roads)
    for (let i = 0; i < rd.p.length - 1; i++) {
      const [ax, az] = rd.p[i], [bx, bz] = rd.p[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 14));
      for (let k = 0; k <= n; k++)
        mark(ax + (bx - ax) * k / n, az + (bz - az) * k / n);
    }
  const livre = (x, z, r) => {
    const c = Math.ceil(r / CELL);
    const cxi = (x / CELL) | 0, czi = (z / CELL) | 0;
    for (let ox = -c; ox <= c; ox++) for (let oz = -c; oz <= c; oz++)
      if (occ.has((cxi + ox) + ',' + (czi + oz))) return false;
    return true;
  };

  const pos = [], col = [], nrm = [], uv = [];
  const PAL = [[0.78, 0.76, 0.72], [0.72, 0.68, 0.62], [0.66, 0.62, 0.60],
               [0.74, 0.66, 0.56], [0.62, 0.64, 0.66], [0.80, 0.74, 0.64]];
  function box(cx, cz, w, d, h, yaw, tint) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const rot = (x, z) => [cx + x * cy - z * sy, cz + x * sy + z * cy];
    const corners = [rot(-w / 2, -d / 2), rot(w / 2, -d / 2), rot(w / 2, d / 2), rot(-w / 2, d / 2)];
    for (let f = 0; f < 4; f++) {
      const a = corners[f], b = corners[(f + 1) % 4];
      const wlen = f % 2 === 0 ? w : d;
      let nx = b[1] - a[1], nz = -(b[0] - a[0]);
      const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
      pos.push(a[0], 0, a[1], b[0], 0, b[1], b[0], h, b[1],
               a[0], 0, a[1], b[0], h, b[1], a[0], h, a[1]);
      const U = wlen / 4.2, V = h / 3.4;
      uv.push(0, 0, U, 0, U, V, 0, 0, U, V, 0, V);
      for (let k = 0; k < 6; k++) { col.push(tint[0], tint[1], tint[2]); nrm.push(nx, 0, nz); }
    }
    pos.push(corners[0][0], h, corners[0][1], corners[1][0], h, corners[1][1], corners[2][0], h, corners[2][1],
             corners[0][0], h, corners[0][1], corners[2][0], h, corners[2][1], corners[3][0], h, corners[3][1]);
    for (let k = 0; k < 6; k++) {
      uv.push(0.01, 0.01);
      col.push(tint[0] * 0.5, tint[1] * 0.5, tint[2] * 0.5);
      nrm.push(0, 1, 0);
    }
  }

  function distRota(x, z) {
    let d2 = 1e18;
    for (const R of ROUTES.slice(0, 2))
      for (let i = 0; i < R.pts.length; i += 8) {
        const dx = R.pts[i].x - x, dz = R.pts[i].z - z;
        const d = dx * dx + dz * dz;
        if (d < d2) d2 = d;
      }
    return Math.sqrt(d2);
  }

  let placed = 0;
  const MAX_BLD = 2100;
  const ways = MAP_DATA.roads.filter(r => r.t === 'pr' || r.t === 'tr' || r.t === 'la');
  for (let wi = 0; wi < ways.length && placed < MAX_BLD; wi += 1) {
    const rd = ways[(wi * 37) % ways.length];
    for (let i = 0; i < rd.p.length - 1 && placed < MAX_BLD; i++) {
      const [ax, az] = rd.p[i], [bx, bz] = rd.p[i + 1];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 40; s < L; s += 80) {
        if (Math.random() < 0.35) continue;
        const t = s / L;
        const x0 = ax + (bx - ax) * t, z0 = az + (bz - az) * t;
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        const side = Math.random() < 0.5 ? -1 : 1;
        const off = 26 + Math.random() * 44;
        const x = x0 + -dz * off * side, z = z0 + dx * off * side;
        const w = 13 + Math.random() * 17;
        if (!livre(x, z, w / 2 + 6) || onBeach(x, z)) continue;
        const h = distRota(x, z) < 480 ? 16 + Math.random() * 52 : 7 + Math.random() * 22;
        const tint = PAL[(Math.random() * PAL.length) | 0];
        const jit = 0.9 + Math.random() * 0.2;
        box(x, z, w, 13 + Math.random() * 17, h, Math.atan2(dx, dz),
          [tint[0] * jit, tint[1] * jit, tint[2] * jit]);
        mark(x, z);
        placed++;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  scene.add(new THREE.Mesh(geo,
    new THREE.MeshLambertMaterial({ vertexColors: true, map: tex, side: THREE.DoubleSide })));
}

// ------------------------------------------------- morros (maciços reais)
{
  const hillMat = new THREE.MeshLambertMaterial({ color: 0x33502f });
  const cands = (MAP_DATA.hills || []).map(h =>
    ({ x: h.p[0], z: h.p[1], r: h.r, h: h.h }));
  // morros flanqueando os túneis da rota principal (nunca tocam a pista)
  const R0 = ROUTES[0];
  for (const [s0, s1] of R0.tunnels) {
    const len = s1 - s0;
    if (len < 400) continue;
    const n = Math.ceil(len / 320);
    for (let k = 0; k < n; k++) {
      const s = s0 + (k + 0.5) * len / n;
      // amostra na rota principal
      let lo = 0, hi = R0.cum.length - 1;
      while (lo < hi - 1) { const m = (lo + hi) >> 1; if (R0.cum[m] <= s) lo = m; else hi = m; }
      const a = R0.pts[lo], b = R0.pts[Math.min(lo + 1, R0.pts.length - 1)];
      const dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz) || 1;
      for (const sgn of [-1, 1]) {
        const r = 150 + Math.random() * 130;
        const off = (r + 26) * sgn;
        cands.push({ x: a.x + -dz / L * off, z: a.z + dx / L * off,
                     r, h: 130 + Math.random() * 150, tunnel: true });
      }
    }
  }
  for (const cd of cands) {
    if (!cd.tunnel) {
      let dmin = 1e18;
      for (const R of ROUTES.slice(0, 2))
        for (let i = 0; i < R.pts.length; i += 4)
          dmin = Math.min(dmin, Math.hypot(R.pts[i].x - cd.x, R.pts[i].z - cd.z));
      if (dmin < cd.r * 0.85) cd.r = Math.max(250, dmin * 0.8);
    }
    const m = new THREE.Mesh(new THREE.ConeGeometry(cd.r, cd.h, 22, 1), hillMat);
    m.position.set(cd.x, 0, cd.z);
    m.scale.x = 0.85 + Math.random() * 0.4;
    m.scale.z = 0.85 + Math.random() * 0.4;
    scene.add(m);
  }
}

// ================================================================ corredor
// toda a geometria que depende da rota ativa (reconstruída ao trocar de rota)
let corridor = null; // { group, gatePool }

function disposeCorridor() {
  if (!corridor) return;
  corridor.group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
  scene.remove(corridor.group);
  corridor = null;
}

function buildCorridor(R) {
  const G = new THREE.Group();
  const P = R.pts;
  const offAt = (i, off) => [P[i].x + P[i].nx * off, P[i].z + P[i].nz * off];

  const EXITS = R.exits;
  const RAIL_GAPS = EXITS.map(e => e.k === 'out'
    ? { s0: e.s - 8, s1: e.s + 55, side: e.side }
    : { s0: e.s - 55, s1: e.s + 8, side: e.side });
  const inGap = (s, side) => RAIL_GAPS.some(g => g.side === side && s >= g.s0 && s <= g.s1);

  // ---- asfalto + marcações
  {
    const pos = [], col = [], nrm = [];
    for (let i = 0; i < P.length - 1; i++) {
      const aL = offAt(i, -P[i].half), aR = offAt(i, P[i].half);
      const bL = offAt(i + 1, -P[i + 1].half), bR = offAt(i + 1, P[i + 1].half);
      const yA = P[i].y + 0.058, yB = P[i + 1].y + 0.058;
      pos.push(aL[0], yA, aL[1], aR[0], yA, aR[1], bR[0], yB, bR[1],
               aL[0], yA, aL[1], bR[0], yB, bR[1], bL[0], yB, bL[1]);
      for (let k = 0; k < 6; k++) { col.push(0.31, 0.31, 0.34); nrm.push(0, 1, 0); }
    }
    for (const sgn of [-1, 1]) {
      const edge = [], ys = [];
      for (let i = 0; i < P.length; i++) {
        edge.push(offAt(i, sgn * (P[i].half - 0.45)));
        ys.push(P[i].y + 0.072);
      }
      ribbonInto(pos, col, nrm, edge, 0.30, ys, 1.0, 0.78, 0.20);
    }
    for (let s = 6; s < R.total - 6; s += 13) {
      const a = sampleOf(R, s);
      const p = P[a.idx];
      const L = p.ln + p.onc;
      for (let k = 1; k < L; k++) {
        const off = (k - L / 2) * 3.6;
        if (p.onc > 0 && k === p.onc) {
          // divisor de mão dupla: faixa dupla amarela contínua
          const b2 = sampleOf(R, Math.min(R.total - 1, s + 13.4));
          for (const dd of [-0.22, 0.22]) {
            ribbonInto(pos, col, nrm,
              [[a.x + -a.dz * (off + dd), a.z + a.dx * (off + dd)],
               [b2.x + -b2.dz * (off + dd), b2.z + b2.dx * (off + dd)]],
              0.16, [a.y + 0.072, b2.y + 0.072], 1.0, 0.72, 0.12);
          }
        } else {
          const b = sampleOf(R, s + 3.2);
          ribbonInto(pos, col, nrm,
            [[a.x + -a.dz * off, a.z + a.dx * off], [b.x + -b.dz * off, b.z + b.dx * off]],
            0.18, [a.y + 0.072, b.y + 0.072], 0.92, 0.92, 0.92);
        }
      }
    }
    G.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- defensas
  {
    const pos = [], col = [], nrm = [];
    for (const sgn of [-1, 1]) {
      for (let i = 0; i < P.length - 1; i++) {
        if (P[i].tun) continue;
        if (inGap((R.cum[i] + R.cum[i + 1]) / 2, sgn)) continue;
        const [ax, az] = offAt(i, sgn * (P[i].half + 0.8));
        const [bx, bz] = offAt(i + 1, sgn * (P[i + 1].half + 0.8));
        const nx = -P[i].nx * sgn, nz = -P[i].nz * sgn;
        pos.push(ax, P[i].y, az, bx, P[i + 1].y, bz, bx, P[i + 1].y + 0.85, bz,
                 ax, P[i].y, az, bx, P[i + 1].y + 0.85, bz, ax, P[i].y + 0.85, az);
        for (let k = 0; k < 6; k++) { col.push(0.62, 0.62, 0.60); nrm.push(nx, 0, nz); }
      }
    }
    G.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- barreiras listradas nas aberturas
  {
    const pos = [], col = [], nrm = [];
    for (const g of RAIL_GAPS) {
      let stripe = 0;
      for (let s = g.s0; s < g.s1; s += 1.6) {
        const a = sampleOf(R, s), b = sampleOf(R, Math.min(g.s1, s + 1.6));
        const latOff = (P[a.idx].half + 0.4) * g.side;
        const ax = a.x + -a.dz * latOff, az = a.z + a.dx * latOff;
        const bx = b.x + -b.dz * latOff, bz = b.z + b.dx * latOff;
        const c = stripe++ % 2 ? [0.95, 0.78, 0.10] : [0.10, 0.10, 0.10];
        pos.push(ax, a.y, az, bx, b.y, bz, bx, b.y + 1.0, bz,
                 ax, a.y, az, bx, b.y + 1.0, bz, ax, a.y + 1.0, az);
        for (let k = 0; k < 6; k++) { col.push(c[0], c[1], c[2]); nrm.push(0, 1, 0); }
      }
    }
    G.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- placas verdes de saída
  {
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555a5e });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.14, 6.4, 8);
    for (const e of EXITS) {
      if (e.k !== 'out') continue;
      const sSign = Math.max(60, e.s - 280);
      const c = sampleOf(R, sSign);
      const latOff = (P[c.idx].half + 3.6) * e.side;
      const px = c.x + -c.dz * latOff, pz = c.z + c.dx * latOff;
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 224;
      const g2 = cv.getContext('2d');
      g2.fillStyle = '#0b6e34'; g2.fillRect(0, 0, 512, 224);
      g2.strokeStyle = '#fff'; g2.lineWidth = 10;
      g2.strokeRect(10, 10, 492, 204);
      g2.fillStyle = '#fff';
      g2.font = 'bold 66px Arial';
      g2.fillText('SAÍDA ' + (e.num || ''), 36, 92);
      g2.font = 'bold 44px Arial';
      g2.fillText((e.n || 'Acesso local').slice(0, 20), 36, 168);
      g2.font = 'bold 80px Arial';
      g2.fillText('↗', 410, 110);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(6.2, 2.7),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide }));
      const h = Math.atan2(c.dx, c.dz);
      board.position.set(px, c.y + 5.0, pz);
      board.rotation.y = h + Math.PI;
      G.add(board);
      const pole = new THREE.Mesh(poleGeo, poleMat);
      pole.position.set(px, c.y + 3.2, pz);
      G.add(pole);
    }
  }

  // ---- pórticos de destino (bairros reais à frente + distância)
  {
    const placeS = [];
    for (const p of (MAP_DATA.places || [])) {
      if (p.t !== 'suburb') continue;
      let bd = 1e18, bs = 0;
      for (let i = 0; i < P.length; i += 4) {
        const dx = P[i].x - p.p[0], dz = P[i].z - p.p[1];
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bs = R.cum[i]; }
      }
      if (Math.sqrt(bd) < 1700 && p.n.length <= 20) placeS.push({ n: p.n, s: bs });
    }
    placeS.sort((a, b) => a.s - b.s);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x555a5e });
    const fmtD = d => d < 950 ? Math.round(d / 100) * 100 + ' m'
      : d < 9500 ? (d / 1000).toFixed(1).replace('.', ',') + ' km'
      : Math.round(d / 1000) + ' km';
    for (let s = 900; s < R.total - 1200; s += 2400) {
      const c = sampleOf(R, s);
      if (P[c.idx].tun) continue;
      if (R.toll && Math.abs(s - R.toll) < 350) continue;
      if (EXITS.some(e => Math.abs(e.s - 280 - s) < 260 || Math.abs(e.s - s) < 220)) continue;
      const rows = [];
      let lastS = s + 500;
      for (const pl of placeS) {
        if (rows.length >= 2) break;
        if (pl.s > lastS + 700) { rows.push({ n: pl.n, d: pl.s - s }); lastS = pl.s; }
      }
      rows.push({ n: R.to, d: Math.max(300, R.total - 150 - s) });
      const cv = document.createElement('canvas');
      cv.width = 640; cv.height = 56 + rows.length * 78;
      const g2 = cv.getContext('2d');
      g2.fillStyle = '#0b6e34'; g2.fillRect(0, 0, cv.width, cv.height);
      g2.strokeStyle = '#fff'; g2.lineWidth = 8;
      g2.strokeRect(8, 8, cv.width - 16, cv.height - 16);
      g2.fillStyle = '#fff'; g2.font = 'bold 46px Arial';
      rows.forEach((r2, i) => {
        const y = 86 + i * 78;
        g2.textAlign = 'left'; g2.fillText(r2.n, 36, y);
        g2.textAlign = 'right'; g2.fillText(fmtD(r2.d), cv.width - 36, y);
      });
      const half = P[c.idx].half;
      const bw = 9.5, bh = bw * cv.height / cv.width;
      const board = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh),
        new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide }));
      const h = Math.atan2(c.dx, c.dz);
      board.position.set(c.x, c.y + 6.5, c.z);
      board.rotation.y = h + Math.PI;
      G.add(board);
      for (const sgn of [-1, 1]) {
        const [px, pz] = offAt(c.idx, sgn * (half + 1.2));
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 8.6, 8), poleMat);
        pole.position.set(px, c.y + 4.3, pz);
        G.add(pole);
      }
      const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * half + 3, 0.35, 0.35), poleMat);
      beam.position.set(c.x, c.y + 8.7, c.z);
      beam.rotation.y = h;
      G.add(beam);
    }
  }

  // ---- pedágio (LAMSA)
  if (R.toll) {
    const c = sampleOf(R, R.toll);
    const tollHalf = P[c.idx].half;
    const h = Math.atan2(c.dx, c.dz);
    const grp = new THREE.Group();
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(34, 1.4, 10),
      new THREE.MeshLambertMaterial({ color: 0xe8e4d8 }));
    canopy.position.y = 6.6;
    grp.add(canopy);
    const cv = document.createElement('canvas');
    cv.width = 1024; cv.height = 96;
    const g2 = cv.getContext('2d');
    g2.fillStyle = '#0b6e34'; g2.fillRect(0, 0, 1024, 96);
    g2.fillStyle = '#fff'; g2.font = 'bold 60px Arial';
    g2.textAlign = 'center';
    g2.fillText('P E D Á G I O  ·  L I N H A  A M A R E L A', 512, 66);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(30, 2.8),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), side: THREE.DoubleSide }));
    sign.position.set(0, 5.0, -5.01);
    sign.rotation.y = Math.PI;
    grp.add(sign);
    const colMat = new THREE.MeshLambertMaterial({ color: 0x8a8a84 });
    const boothMat = new THREE.MeshLambertMaterial({ color: 0xd8d4c4 });
    for (const lx of [-(tollHalf + 8.6), -(tollHalf + 1.8), tollHalf + 1.8, tollHalf + 8.6]) {
      const col2 = new THREE.Mesh(new THREE.BoxGeometry(0.8, 6.6, 0.8), colMat);
      col2.position.set(lx, 3.3, 0);
      grp.add(col2);
    }
    for (const lx of [-(tollHalf + 1.8), tollHalf + 1.8]) {
      const booth = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 3.4), boothMat);
      booth.position.set(lx, 1.3, 0);
      grp.add(booth);
    }
    grp.position.set(c.x, c.y, c.z);
    grp.rotation.y = h;
    G.add(grp);
    const pos = [], col = [], nrm = [];
    for (let k = 0; k < 7; k++) {
      const s = R.toll - 26 - k * 9;
      const a = sampleOf(R, s), b = sampleOf(R, s + 4.5);
      ribbonInto(pos, col, nrm,
        [[a.x, a.z], [b.x, b.z]], tollHalf * 2 - 1.6,
        [a.y + 0.068, b.y + 0.068], 0.85, 0.85, 0.82);
    }
    G.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- túneis: paredes, teto, luzes, portais
  const tunnelRuns = [];
  {
    let start = -1;
    for (let i = 0; i < P.length; i++) {
      if (P[i].tun && start < 0) start = i;
      if ((!P[i].tun || i === P.length - 1) && start >= 0) {
        if (i - start > 1) tunnelRuns.push([start, i]);
        start = -1;
      }
    }
    const pos = [], col = [], nrm = [];
    const lpos = [], lcol = [], lnrm = [];
    for (const [i0, i1] of tunnelRuns) {
      for (let i = i0; i < i1; i++) {
        const wA = P[i].half + 1.4, wB = P[i + 1].half + 1.4;
        for (const sgn of [-1, 1]) {
          const [ax, az] = offAt(i, sgn * wA);
          const [bx, bz] = offAt(i + 1, sgn * wB);
          const nx = -P[i].nx * sgn, nz = -P[i].nz * sgn;
          pos.push(ax, 0, az, bx, 0, bz, bx, 5.6, bz, ax, 0, az, bx, 5.6, bz, ax, 5.6, az);
          for (let k = 0; k < 6; k++) { col.push(0.16, 0.15, 0.14); nrm.push(nx, 0, nz); }
        }
        const aL = offAt(i, -wA), aR = offAt(i, wA);
        const bL = offAt(i + 1, -wB), bR = offAt(i + 1, wB);
        pos.push(aL[0], 5.6, aL[1], aR[0], 5.6, aR[1], bR[0], 5.6, bR[1],
                 aL[0], 5.6, aL[1], bR[0], 5.6, bR[1], bL[0], 5.6, bL[1]);
        for (let k = 0; k < 6; k++) { col.push(0.12, 0.11, 0.10); nrm.push(0, -1, 0); }
      }
      for (const idx of [i0, i1]) {
        const c = sampleOf(R, R.cum[idx]);
        const wT = P[idx].half + 1.4;
        const Q = (lat, y) => [c.x + -c.dz * lat, y, c.z + c.dx * lat];
        const rects = [[-15, 15, 5.6, 12.5], [-15, -wT, 0, 5.6], [wT, 15, 0, 5.6]];
        for (const [l0, l1, y0, y1] of rects) {
          const A = Q(l0, y0), B = Q(l1, y0), C2 = Q(l1, y1), D2 = Q(l0, y1);
          pos.push(...A, ...B, ...C2, ...A, ...C2, ...D2);
          for (let k = 0; k < 6; k++) { col.push(0.24, 0.23, 0.21); nrm.push(-c.dx, 0, -c.dz); }
        }
      }
      for (let s = R.cum[i0] + 15; s < R.cum[i1] - 10; s += 38) {
        const c = sampleOf(R, s);
        const w = 1.6, l = 3.2;
        const ax = c.x - c.dx * l / 2, az = c.z - c.dz * l / 2;
        const bx = c.x + c.dx * l / 2, bz = c.z + c.dz * l / 2;
        const pX = -c.dz * w / 2, pZ = c.dx * w / 2;
        lpos.push(ax - pX, 5.45, az - pZ, ax + pX, 5.45, az + pZ, bx + pX, 5.45, bz + pZ,
                  ax - pX, 5.45, az - pZ, bx + pX, 5.45, bz + pZ, bx - pX, 5.45, bz - pZ);
        for (let k = 0; k < 6; k++) { lcol.push(1.0, 0.93, 0.65); lnrm.push(0, -1, 0); }
      }
    }
    G.add(makeMergedMesh(pos, col, nrm,
      new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })));
    G.add(makeMergedMesh(lpos, lcol, lnrm,
      new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

  // ---- portais de checkpoint (pool a cada 1500 m)
  const gatePool = [];
  const pylonG = new THREE.CylinderGeometry(0.45, 0.55, 7, 10);
  function buildGate(s, color) {
    const c = sampleOf(R, s);
    const half = P[c.idx].half;
    const grp = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
    for (const side of [-(half + 0.8), half + 0.8]) {
      const p = new THREE.Mesh(pylonG, mat);
      p.position.set(c.x + -c.dz * side, c.y + 3.5, c.z + c.dx * side);
      grp.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * half + 2.2, 0.7, 0.35), mat);
    beam.position.set(c.x, c.y + 6.8, c.z);
    beam.rotation.y = Math.atan2(c.dx, c.dz);
    grp.add(beam);
    G.add(grp);
    return { grp, mat, s };
  }
  for (let s = 1400; s < R.total - 600; s += 1500)
    gatePool.push(buildGate(s, 0xffd34d));

  scene.add(G);
  return { group: G, gatePool, buildGate };
}

// amostra de uma rota específica (usada na construção de corredores)
function sampleOf(R, s) {
  s = Math.max(0, Math.min(R.total - 0.01, s));
  let lo = 0, hi = R.cum.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (R.cum[m] <= s) lo = m; else hi = m; }
  const a = R.pts[lo], b = R.pts[lo + 1];
  const seg = R.cum[lo + 1] - R.cum[lo];
  const t = seg > 0 ? (s - R.cum[lo]) / seg : 0;
  let dx = b.x - a.x, dz = b.z - a.z;
  const L = Math.hypot(dx, dz) || 1; dx /= L; dz /= L;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t,
           y: a.y + (b.y - a.y) * t, dx, dz, idx: lo };
}

function selectRoute(R) {
  if (ROUTE === R && corridor) return;
  disposeCorridor();
  ROUTE = R;
  corridor = buildCorridor(R);
  bakeRouteOverlay();
}

// ================================================================ carros
const CARS = [
  { name: 'Fiat Uno Mille', cat: 'POPULAR · 155 km/h · ágil', color: 0xdfdfd6,
    vmax: 43, acc: 8.5, yaw: 1.2, grip: 8.2, body: [1.55, 0.66, 3.6], cab: [1.42, 0.5, 1.7, -0.05] },
  { name: 'Renault Kwid', cat: 'POPULAR · 160 km/h · compacto', color: 0xd4622a,
    vmax: 44.5, acc: 9, yaw: 1.18, grip: 8.0, body: [1.6, 0.7, 3.68], cab: [1.45, 0.42, 1.6, 0.05] },
  { name: 'Honda WR-V', cat: 'SUV COMPACTO · 172 km/h', color: 0x8a8f96,
    vmax: 48, acc: 9.6, yaw: 1.08, grip: 7.6, body: [1.73, 0.74, 3.95], cab: [1.55, 0.45, 1.9, 0.0] },
  { name: 'VW Gol GTI', cat: 'POPULAR TURBO · 195 km/h', color: 0xb01818,
    vmax: 54, acc: 11, yaw: 1.1, grip: 7.8, body: [1.65, 0.56, 3.9], cab: [1.5, 0.46, 1.8, -0.15] },
  { name: 'Honda HR-V', cat: 'SUV · 197 km/h', color: 0x2e3640,
    vmax: 54.5, acc: 10.8, yaw: 1.02, grip: 7.4, body: [1.79, 0.76, 4.34], cab: [1.6, 0.46, 2.1, -0.05] },
  { name: 'Chevrolet Opala SS', cat: 'MUSCLE BR · 215 km/h · traseira solta', color: 0x1c1e22,
    vmax: 60, acc: 12, yaw: 0.85, grip: 5.6, body: [1.9, 0.55, 4.9], cab: [1.62, 0.45, 2.2, -0.2] },
  { name: 'Honda Civic Si', cat: 'TUNER · 235 km/h', color: 0xe8b820,
    vmax: 65, acc: 13, yaw: 1.05, grip: 7.6, body: [1.75, 0.5, 4.4], cab: [1.55, 0.45, 2.0, -0.2], spoiler: true },
  { name: 'BMW M3 GTR', cat: 'MOST WANTED · 280 km/h', color: 0xd8dde4,
    vmax: 78, acc: 14.5, yaw: 1.0, grip: 7.5, body: [1.85, 0.52, 4.5], cab: [1.6, 0.46, 2.1, -0.25], spoiler: true, stripes: true },
  { name: 'Porsche 911 Turbo', cat: 'SUPER · 305 km/h', color: 0xc8cdd6,
    vmax: 85, acc: 16, yaw: 0.95, grip: 7.2, body: [1.82, 0.46, 4.3], cab: [1.5, 0.4, 1.9, -0.35], spoiler: true },
];
let carIdx = Math.min(CARS.length - 1, parseInt(localStorage.getItem('rmw_car') || '7', 10) || 0);
let spec = CARS[carIdx];

function buildPlayerCar(s) {
  const g = new THREE.Group();
  const [bw, bh, bl] = s.body;
  const body = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bl),
    new THREE.MeshLambertMaterial({ color: s.color }));
  body.position.y = 0.30 + bh / 2; g.add(body);
  const [cw, ch, cl, cz] = s.cab;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(cw, ch, cl),
    new THREE.MeshLambertMaterial({ color: 0x14161a }));
  cabin.position.set(0, 0.30 + bh + ch / 2, cz); g.add(cabin);
  if (s.stripes) {
    for (const sx of [-0.28, 0.28]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.03, bl),
        new THREE.MeshLambertMaterial({ color: 0x2256cc }));
      st.position.set(sx, 0.315 + bh, 0); g.add(st);
    }
  }
  if (s.spoiler) {
    const sp = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.92, 0.06, 0.42),
      new THREE.MeshLambertMaterial({ color: 0x222428 }));
    sp.position.set(0, 0.55 + bh + 0.18, -bl / 2 + 0.25); g.add(sp);
  }
  const wgeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 12);
  wgeo.rotateZ(Math.PI / 2);
  const wmat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  const wheels = [];
  for (const [wx, wz] of [[-(bw / 2 - 0.08), bl / 2 - 0.85], [bw / 2 - 0.08, bl / 2 - 0.85],
                          [-(bw / 2 - 0.08), -(bl / 2 - 0.85)], [bw / 2 - 0.08, -(bl / 2 - 0.85)]]) {
    const w = new THREE.Mesh(wgeo, wmat);
    w.position.set(wx, 0.34, wz); g.add(w); wheels.push(w);
  }
  const hl = new THREE.MeshBasicMaterial({ color: 0xfff6cc });
  const tl = new THREE.MeshBasicMaterial({ color: 0xff2a18 });
  for (const sx of [-bw / 3, bw / 3]) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), hl);
    f.position.set(sx, 0.42 + bh / 2, bl / 2 + 0.01); g.add(f);
    const r = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.06), tl);
    r.position.set(sx, 0.42 + bh / 2, -(bl / 2 + 0.01)); g.add(r);
  }
  g.userData.wheels = wheels;
  return g;
}

let car = buildPlayerCar(spec);
scene.add(car);

function applyCar() {
  spec = CARS[carIdx];
  const px = car.position.x, py = car.position.y, pz = car.position.z, ry = car.rotation.y;
  scene.remove(car);
  car = buildPlayerCar(spec);
  car.position.set(px, py, pz);
  car.rotation.y = ry;
  scene.add(car);
  localStorage.setItem('rmw_car', String(carIdx));
}

// ================================================================ tráfego
const TRAF_LEVELS = [
  { n: 'LEVE', d: 'madrugada — pista quase livre', c: 14 },
  { n: 'MÉDIO', d: 'o padrão fora do horário de pico', c: 32 },
  { n: 'PESADO', d: 'fim de tarde na Linha Amarela', c: 55 },
  { n: 'CAÓTICO', d: 'véspera de feriado com chuva', c: 80 },
];
let trafIdx = Math.min(TRAF_LEVELS.length - 1, parseInt(localStorage.getItem('rmw_traf') || '1', 10) || 0);
const TRAFFIC_MAX = 80;
const TRAFFIC_COLORS = [0x8a2020, 0x204a8a, 0xcfcfcf, 0x2a2a2a, 0x9a8a30, 0x3a6a3a, 0x6a4a8a, 0xc46a20];

function buildTrafficCar(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.55, 4.0),
    new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.58; g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.42, 1.9),
    new THREE.MeshLambertMaterial({ color: 0x16181c }));
  cabin.position.set(0, 1.04, -0.2); g.add(cabin);
  const wmat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  for (const wz of [1.3, -1.3]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.78, 0.6, 0.62), wmat);
    bar.position.set(0, 0.3, wz); g.add(bar);
  }
  const tl = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.06),
    new THREE.MeshBasicMaterial({ color: 0xff2a18 }));
  tl.position.set(0, 0.7, -2.01); g.add(tl);
  return g;
}

function buildMoto(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.9),
    new THREE.MeshLambertMaterial({ color }));
  body.position.y = 0.72; g.add(body);
  const wmat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  for (const wz of [0.75, -0.75]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.62, 0.62), wmat);
    w.position.set(0, 0.31, wz); g.add(w);
  }
  // piloto
  const rider = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.5),
    new THREE.MeshLambertMaterial({ color: 0x22262e }));
  rider.position.set(0, 1.22, -0.25); g.add(rider);
  const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.34),
    new THREE.MeshLambertMaterial({ color: 0xc23030 }));
  helmet.position.set(0, 1.7, -0.25); g.add(helmet);
  const tl = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.1, 0.05),
    new THREE.MeshBasicMaterial({ color: 0xff2a18 }));
  tl.position.set(0, 0.74, -0.99); g.add(tl);
  return g;
}

let trafPh1 = Math.random() * 9, trafPh2 = Math.random() * 9;
function densityAt(s) {
  return 0.22 + 0.78 * (0.5 + 0.5 * Math.sin(s * 0.0011 + trafPh1))
              * (0.55 + 0.45 * Math.sin(s * 0.00037 + trafPh2));
}
function randomTrafficS(lo, hi) {
  for (let k = 0; k < 14; k++) {
    const s = lo + Math.random() * (hi - lo);
    if (Math.random() < densityAt(s)) return s;
  }
  return lo + Math.random() * (hi - lo);
}

// velocidades: média igual à antiga, mas com mais variação entre veículos
const carSpeed = () => 20.5 + (Math.random() * 12 - 6);   // 14,5–26,5 m/s
const motoSpeed = () => 27 + (Math.random() * 10 - 5);    // 22–32 m/s (mais rápidas)

const traffic = [];
for (let i = 0; i < TRAFFIC_MAX; i++) {
  const moto = i % 6 === 5; // ~1 moto a cada 6 veículos
  const mesh = moto
    ? buildMoto(TRAFFIC_COLORS[(i * 5) % TRAFFIC_COLORS.length])
    : buildTrafficCar(TRAFFIC_COLORS[i % TRAFFIC_COLORS.length]);
  mesh.visible = false;
  scene.add(mesh);
  traffic.push({
    mesh, active: false, s: 0, moto,
    li: (Math.random() * 5) | 0,
    off: null,
    chT: 4 + Math.random() * 10,
    v: moto ? motoSpeed() : carSpeed(),
  });
}

// offset lateral do veículo t no ponto idx (null = sentido inexistente)
// motos andam no CORREDOR: a divisa entre faixas do próprio sentido
function laneOffset(t, idx) {
  const p = ROUTE.pts[idx];
  const L = p.ln + p.onc;
  if (t.moto) {
    if (p.ln >= 2) {
      const k = p.onc + 1 + Math.min(t.li, p.ln - 2); // divisa entre faixas próprias
      return (k - L / 2) * 3.6;
    }
    // faixa única: moto anda na faixa mesmo
    return (p.onc - (L - 1) / 2) * 3.6;
  }
  if (t.dir < 0) {
    if (p.onc === 0) return null; // mão única: contramão não existe aqui
    const k = Math.min(t.li, p.onc - 1);
    return (k - (L - 1) / 2) * 3.6;
  }
  const k = p.onc + Math.min(t.li, p.ln - 1);
  return (k - (L - 1) / 2) * 3.6;
}

function respawnTraffic(t, playerS) {
  t.s = randomTrafficS(playerS + 300, playerS + 1900);
  if (t.s > ROUTE.total - 100) t.s = randomTrafficS(150, 650);
  // em trechos de mão dupla, parte do tráfego vem na contramão (motos não)
  const idx = sampleOf(ROUTE, t.s).idx;
  t.dir = (!t.moto && ROUTE.pts[idx].onc > 0 && Math.random() < 0.45) ? -1 : 1;
  t.li = (Math.random() * 5) | 0;
  t.off = null;
  t.chT = 4 + Math.random() * 10;
  t.v = t.moto ? motoSpeed() : carSpeed();
  t.wreck = null;
  t.mesh.rotation.set(0, 0, 0);
}

function stepTraffic(dt, playerS) {
  for (const t of traffic) {
    if (!t.active) continue;
    if (t.wreck) {
      const w = t.wreck; w.t += dt;
      w.wy -= 13 * dt;
      w.y = Math.max(0, w.y + w.wy * dt);
      if (w.y === 0 && w.wy < 0) w.wy = -w.wy * 0.38;
      w.vx *= Math.exp(-1.5 * dt); w.vz *= Math.exp(-1.5 * dt);
      t.mesh.position.x += w.vx * dt;
      t.mesh.position.z += w.vz * dt;
      const cc = routeClosest(t.mesh.position.x, t.mesh.position.z, sampleOf(ROUTE, t.s).idx);
      const wl = ROUTE.pts[cc.idx].wall - 0.4;
      if (Math.abs(cc.lat) > wl) {
        const over = Math.abs(cc.lat) - wl, sg = Math.sign(cc.lat);
        t.mesh.position.x -= cc.rX * sg * over;
        t.mesh.position.z -= cc.rZ * sg * over;
        const vl = w.vx * cc.rX + w.vz * cc.rZ;
        w.vx -= cc.rX * vl * 1.5; w.vz -= cc.rZ * vl * 1.5;
      }
      const dec = Math.exp(-0.85 * w.t);
      t.mesh.rotation.x += w.rx * dt * dec;
      t.mesh.rotation.z += w.rz * dt * dec;
      const lift = 0.95 * Math.max(Math.abs(Math.sin(t.mesh.rotation.x)),
                                   Math.abs(Math.sin(t.mesh.rotation.z)));
      t.mesh.position.y = cc.y + w.y + lift;
      if (w.t > 6 || t.s < playerS - 900) respawnTraffic(t, playerS);
      continue;
    }
    let v = t.v;
    if (ROUTE.toll !== null && t.dir > 0) {
      const dToll = t.s < ROUTE.toll ? ROUTE.toll - t.s : t.s - ROUTE.toll - 40;
      if (dToll > -40 && dToll < 240) v = Math.min(v, 6 + Math.max(0, dToll) / 240 * 19);
    }
    t.s += v * dt * (t.dir || 1);
    if (t.s > ROUTE.total - 60 || t.s < 60 ||
        (t.dir > 0 && t.s < playerS - 900) || (t.dir < 0 && t.s < playerS - 300)) {
      respawnTraffic(t, playerS);
    }
    const c = routeSample(t.s);
    t.chT -= dt;
    if (t.chT <= 0) {
      t.chT = 5 + Math.random() * 11;
      if (Math.random() < 0.6) {
        const p = ROUTE.pts[c.idx];
        const max = t.moto ? p.ln - 2 : (t.dir < 0 ? p.onc : p.ln) - 1;
        const cur = Math.min(t.li, Math.max(0, max));
        t.li = Math.max(0, Math.min(Math.max(0, max), cur + (Math.random() < 0.5 ? -1 : 1)));
      }
    }
    const alvo = laneOffset(t, c.idx);
    if (alvo === null) { respawnTraffic(t, playerS); continue; }
    if (t.off === null) t.off = alvo;
    t.off += (alvo - t.off) * Math.min(1, 1.6 * dt);
    t.mesh.position.set(c.x + -c.dz * t.off, c.y, c.z + c.dx * t.off);
    t.mesh.rotation.y = Math.atan2(c.dx, c.dz) - (alvo - t.off) * 0.06
      + (t.dir < 0 ? Math.PI : 0);
  }
}

// ================================================================ polícia
const POLICE_MAX = 4;
function buildPoliceCar() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.4),
    new THREE.MeshLambertMaterial({ color: 0xe8e8e8 }));
  body.position.y = 0.58; g.add(body);
  const doors = new THREE.Mesh(new THREE.BoxGeometry(1.82, 0.28, 1.5),
    new THREE.MeshLambertMaterial({ color: 0x101014 }));
  doors.position.y = 0.52; g.add(doors);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.42, 2.0),
    new THREE.MeshLambertMaterial({ color: 0x16181c }));
  cabin.position.set(0, 1.06, -0.2); g.add(cabin);
  const wmat = new THREE.MeshLambertMaterial({ color: 0x141414 });
  for (const wz of [1.4, -1.4]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1.88, 0.6, 0.62), wmat);
    bar.position.set(0, 0.3, wz); g.add(bar);
  }
  const red = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34),
    new THREE.MeshBasicMaterial({ color: 0xff2020 }));
  red.position.set(-0.3, 1.36, -0.2); g.add(red);
  const blue = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.34),
    new THREE.MeshBasicMaterial({ color: 0x3060ff }));
  blue.position.set(0.3, 1.36, -0.2); g.add(blue);
  g.userData.red = red; g.userData.blue = blue;
  return g;
}
const policeCars = [];
for (let i = 0; i < POLICE_MAX; i++) {
  const mesh = buildPoliceCar();
  mesh.visible = false;
  scene.add(mesh);
  policeCars.push({ mesh, active: false, s: 0, v: 0, off: 0 });
}
let pursuit = null;

// parâmetros da fuga (distância ao longo da rota, em metros)
// IMPORTANTE: o spawn máximo precisa ficar bem abaixo de ESCAPE_DIST, senão a
// viatura nasce longe o bastante para a fuga disparar sem você abrir distância.
// A margem (ESCAPE_DIST - spawn) só se fecha pilotando: no MW a polícia iguala
// sua vmax, então só nitro em estirada longa vence; nos níveis fáceis ela é
// mais lenta e você abre na própria reta.
const ESCAPE_DIST = 340, ESCAPE_HOLD = 3.0; // > spawn máx (290): sem fuga por spawn
const CATCH_DIST = 8, CATCH_HOLD = 3.6;

function startPursuit(playerS) {
  if (!policeOn || state !== 'race') return;
  const want = pursuit ? Math.min(POLICE_MAX, pursuit.n + 1) : 2;
  const fresh = !pursuit;
  const isMW = diffIdx === DIFF_LEVELS.length - 1;
  if (fresh) {
    pursuit = { t: 0, escapeT: 0, catchT: 0, n: 0, grace: 0 };
    pursuit.grace = 4.0;
  } else if (!isMW) {
    // só no MOST WANTED a batida durante a fuga NÃO dá folga; nos demais níveis
    // qualquer batida reativa o tempo de recuperação (polícia desacelera)
    pursuit.grace = 4.0;
  }
  pursuit.escapeT = 0;
  const polF = DIFF_LEVELS[diffIdx].pol;
  const polVmax = spec.vmax * polF;
  for (const pc of policeCars) {
    if (pursuit.n >= want) break;
    if (pc.active) continue;
    pc.active = true; pc.mesh.visible = true;
    // novas batidas: a viatura entra mais perto (você já está lento).
    // teto (290) < ESCAPE_DIST (340) para o spawn nunca virar fuga sozinho;
    // o grace segura o gap durante a recuperação, então não precisa nascer longe
    const back = fresh ? 230 + Math.random() * 60
                       : 120 + Math.random() * 60;
    pc.s = Math.max(20, playerS - back);
    pc.v = polF * Math.min(spec.vmax, ROUTE.pts[routeSample(pc.s).idx].vapp);
    pc.off = 0;
    pursuit.n++;
  }
  showMsg('A POLÍCIA ESTÁ ATRÁS DE VOCÊ!', 1.6);
  document.getElementById('heat').style.display = 'block';
}

function endPursuit(escaped) {
  if (!pursuit) return;
  pursuit = null;
  for (const pc of policeCars) { pc.active = false; pc.mesh.visible = false; }
  document.getElementById('heat').style.display = 'none';
  if (escaped) { showMsg('VOCÊ DESPISTOU A POLÍCIA!', 1.8); cpSound(); }
  if (actx) sirenGain.gain.setTargetAtTime(0, actx.currentTime, 0.25);
}

// ritmo de um piloto ideal em pc.s (vmax do seu carro, freando p/ as curvas
// à frente), escalado pelo fator da dificuldade: MW = ideal pleno; níveis
// menores ficam proporcionalmente mais lentos em TUDO (reta e curva)
function idealSpeedAt(s, polF) {
  const i = routeSample(s).idx;
  return polF * Math.min(spec.vmax, ROUTE.pts[i].vapp);
}

function stepPolice(dt, playerS, playerLat, playerSpd) {
  if (!pursuit || state !== 'race') return;
  pursuit.t += dt;
  pursuit.grace = Math.max(0, pursuit.grace - dt);
  // a polícia é um piloto perfeito num carro IGUAL ao seu, sem nitro
  const polF = DIFF_LEVELS[diffIdx].pol;
  const polVmax = spec.vmax * polF;
  // piloto perfeito: anda no ritmo ideal das curvas, MAS nunca mais devagar que
  // você (até o teto dele). Assim você não ganha distância "cortando" curva
  // melhor que ela — só com velocidade de ponta maior (níveis fáceis) ou nitro.
  const keepUp = Math.min(playerSpd, polVmax);
  let nearGap = 1e9, pcNear = 0; // menor distância ao longo da rota até uma viatura
  for (const pc of policeCars) {
    if (!pc.active) continue;
    let target = Math.max(idealSpeedAt(pc.s, polF), keepUp);
    // durante a recuperação da batida (grace), a viatura NÃO fecha distância:
    // anda no seu ritmo e preserva o gap, te dando tempo de acelerar de volta.
    // Sem isso ela chega a toda enquanto você está lento e prende na hora.
    if (pursuit.grace > 0) target = Math.min(target, playerSpd + 2);
    if (pc.v < target)
      pc.v = Math.min(target, pc.v + spec.acc * 1.2 * Math.max(0.25, 1 - pc.v / polVmax) * dt);
    else
      pc.v = Math.max(target, pc.v - 24 * dt); // frenagem para a curva
    pc.s += pc.v * dt;
    pc.s = Math.min(pc.s, playerS + 3);           // não ultrapassa: encurrala
    if (pc.s > ROUTE.total - 25) pc.s = ROUTE.total - 25;
    const c = routeSample(pc.s);
    pc.off += (playerLat - pc.off) * Math.min(1, 1.5 * dt);
    const wl = ROUTE.pts[c.idx].wall - 0.6;
    pc.off = Math.max(-wl, Math.min(wl, pc.off));
    pc.mesh.position.set(c.x + -c.dz * pc.off, c.y, c.z + c.dx * pc.off);
    pc.mesh.rotation.y = Math.atan2(c.dx, c.dz);
    const ph = Math.floor(performance.now() / 120) % 2;
    pc.mesh.userData.red.visible = ph === 0;
    pc.mesh.userData.blue.visible = ph === 1;
    const g = playerS - pc.s;
    if (g < nearGap) { nearGap = g; pcNear = pc.v; }
    // contato físico: a viatura encostada te segura
    const d = Math.hypot(pc.mesh.position.x - player.x, pc.mesh.position.z - player.z);
    if (d < 3.4 && pursuit.grace <= 0) { player.vx *= 0.99; player.vz *= 0.99; }
  }
  pursuit.nearGap = nearGap;
  pursuit.pcSpd = pcNear; // velocidade da viatura mais próxima
  pursuit.playerSpd = playerSpd;
  // prisão e fuga decididas pela distância ao longo da rota (sem elástico):
  // só o nitro abre vantagem; bater/desacelerar deixa a polícia colar
  if (pursuit.grace <= 0 && nearGap < CATCH_DIST) pursuit.catchT += dt;
  else pursuit.catchT = Math.max(0, pursuit.catchT - dt * 0.7);
  if (pursuit.grace <= 0 && nearGap > ESCAPE_DIST && playerSpd > 12) pursuit.escapeT += dt;
  else pursuit.escapeT = Math.max(0, pursuit.escapeT - dt * 0.35);
  updateSiren(Math.max(0.15, 1 - nearGap / 380));
  if (pursuit.escapeT > ESCAPE_HOLD) {
    endPursuit(true);
  } else if (pursuit.catchT > CATCH_HOLD) {
    endPursuit(false);
    state = 'fail';
    document.getElementById('failTitle').textContent = 'VOCÊ FOI PRESO';
    document.getElementById('failSub').textContent = 'A POLÍCIA TE CERCOU NA FUGA';
    document.getElementById('fail').style.display = 'flex';
    document.getElementById('distfail').textContent =
      `VOCÊ PERCORREU ${((playerS - raceS0) / 1000).toFixed(1)} KM DE ${raceKm()} KM`;
  }
}

// ================================================================ trajetos
// pontos de largada/chegada: 3 terminais + pontos intermediários nomeados
const RACE_POINTS = (() => {
  const terms = [...new Set(ROUTES.flatMap(R => [R.from, R.to]))];
  const list = terms.map(n => ({ n, terminal: true }));
  for (const p of (MAP_DATA.points || []))
    list.push({ n: p.n, xz: p.p, terminal: false });
  return list;
})();

// posição s de um ponto numa rota (null se não pertence)
function pointS(R, pt) {
  if (pt.terminal) {
    if (R.from === pt.n) return 0;
    if (R.to === pt.n) return R.total;
    return null;
  }
  let bd = 1e18, bs = null;
  for (let i = 0; i < R.pts.length; i += 2) {
    const dx = R.pts[i].x - pt.xz[0], dz = R.pts[i].z - pt.xz[1];
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; bs = R.cum[i]; }
  }
  return Math.sqrt(bd) < 130 ? bs : null;
}
// cache: s de cada ponto em cada rota
for (const R of ROUTES) R.pointS = RACE_POINTS.map(pt => pointS(R, pt));

function resolveRace(iStart, iEnd) {
  if (iStart === iEnd) return null;
  let best = null;
  for (const R of ROUTES) {
    const sA = R.pointS[iStart], sB = R.pointS[iEnd];
    if (sA === null || sB === null || sB - sA < 1500) continue;
    if (!best || (sB - sA) < best.dist)
      best = { R, sA, sB, dist: sB - sA };
  }
  return best;
}

let wpStart = 0, wpEnd = 0;
{
  const sN = localStorage.getItem('rmw_startn'), eN = localStorage.getItem('rmw_endn');
  wpStart = Math.max(0, RACE_POINTS.findIndex(p => p.n === sN));
  wpEnd = Math.max(0, RACE_POINTS.findIndex(p => p.n === eN));
  if (!resolveRace(wpStart, wpEnd)) {
    wpStart = RACE_POINTS.findIndex(p => p.n === 'Recreio');
    wpEnd = RACE_POINTS.findIndex(p => p.n === 'Fundão');
    if (wpStart < 0) wpStart = 0;
    if (wpEnd < 0) wpEnd = 1;
  }
}
let accelAuto = localStorage.getItem('rmw_auto') === '1';
let policeOn = localStorage.getItem('rmw_police') !== '0';
// m   = margem sobre o tempo ideal simulado do SEU carro (0 = sem relógio)
// pol = velocidade-teto da polícia como fração do SEU vmax (1.0 = igual, MW)
//       a polícia pilota perfeitamente e freia nas curvas, mas não tem nitro
const DIFF_LEVELS = [
  { n: 'PASSEIO', d: 'sem contra-relógio — só você, a pista e a polícia', m: 0, pol: 0.72 },
  { n: 'FÁCIL', d: 'checkpoints folgados, polícia mais lenta', m: 1.55, pol: 0.80 },
  { n: 'NORMAL', d: 'o equilíbrio padrão', m: 1.32, pol: 0.87 },
  { n: 'DIFÍCIL', d: 'pé embaixo o tempo todo', m: 1.16, pol: 0.94 },
  { n: 'MOST WANTED', d: 'polícia com a sua máxima — só o nitro te salva', m: 1.04, pol: 1.0 },
];
let diffIdx = Math.min(DIFF_LEVELS.length - 1, parseInt(localStorage.getItem('rmw_diff') || '2', 10) || 0);

// ================================================================ corrida
// simula o "tempo ideal" do carro escolhido no trecho: perfil de velocidade
// limitado por curvatura (freia nas curvas bruscas), aceleração/vmax do carro
// e atrasado pelo fluxo de tráfego — cada checkpoint ganha o tempo justo
function computePace(spawnS, fimS) {
  const P = ROUTE.pts, C = ROUTE.cum;
  const i0 = Math.max(0, routeSample(spawnS).idx);
  const i1 = Math.min(P.length - 1, routeSample(fimS).idx + 1);
  const n = i1 - i0 + 1;
  if (n < 2) return { tAt: () => 0 };
  const vlim = new Array(n);
  for (let k = 0; k < n; k++)
    vlim[k] = Math.min(spec.vmax, P[i0 + k].vcurve); // curvatura pré-computada
  const v = new Array(n);
  v[0] = 8;
  for (let k = 1; k < n; k++) {
    const ds = C[i0 + k] - C[i0 + k - 1];
    const a = spec.acc * Math.max(0.18, 1 - v[k - 1] / spec.vmax);
    v[k] = Math.min(vlim[k], Math.sqrt(v[k - 1] * v[k - 1] + 2 * a * ds));
  }
  for (let k = n - 2; k >= 0; k--) {
    const ds = C[i0 + k + 1] - C[i0 + k];
    v[k] = Math.min(v[k], Math.sqrt(v[k + 1] * v[k + 1] + 2 * 20 * ds));
  }
  const tf = [0.05, 0.10, 0.18, 0.28][trafIdx];
  const cum = new Array(n);
  cum[0] = 0;
  for (let k = 1; k < n; k++) {
    const ds = C[i0 + k] - C[i0 + k - 1];
    const vm = Math.max(3, (v[k] + v[k - 1]) / 2);
    cum[k] = cum[k - 1] + ds / vm * (1 + tf * densityAt(C[i0 + k]));
  }
  const tAt = s => {
    s = Math.max(C[i0], Math.min(C[i1], s));
    let lo = 0, hi = n - 1;
    while (lo < hi - 1) { const m2 = (lo + hi) >> 1; if (C[i0 + m2] <= s) lo = m2; else hi = m2; }
    const ds = C[i0 + lo + 1] - C[i0 + lo] || 1;
    return cum[lo] + (cum[lo + 1] - cum[lo]) * ((s - C[i0 + lo]) / ds);
  };
  return { tAt };
}
let cpGrants = [];     // tempo concedido ao cruzar cada checkpoint
let noTimer = false;   // PASSEIO: sem contra-relógio
let cps = [], activeGates = [], finishS = 1, raceS0 = 0;
function raceKm() {
  return ((finishS - raceS0) / 1000).toFixed(1).replace('.', ',');
}

const NOS_ARM = 50; // % de carga necessária para ARMAR o nitro (anti-feathering)
const player = {
  x: 0, z: 0, h: 0, vx: 0, vz: 0, hint: 0,
  nos: 100, steer: 0, nosArmed: false,
};
let stunT = 0, stunSpin = 0, crashImmunity = 0;
let state = 'intro';
let timeLeft = 55, raceTime = 0, nextCp = 0, countT = 0;
let camMode = 0, muted = false, paused = false;
let DEBUG = false; // HUD de monitoramento da perseguição (F2 ou B alterna)
let finishGate = null;

function resetGame() {
  const race = resolveRace(wpStart, wpEnd);
  if (!race) return;
  for (const k in keys) keys[k] = false; // teclas do menu não vazam p/ corrida
  selectRoute(race.R);
  raceS0 = Math.max(0, race.sA);
  finishS = Math.min(race.sB, ROUTE.total - 120);
  const spawnS = raceS0 + 40;
  cps = []; activeGates = [];
  for (const g of corridor.gatePool) {
    const dentro = g.s > spawnS + 800 && g.s < finishS - 500;
    g.grp.visible = dentro;
    g.mat.opacity = 0.9;
    if (dentro) { cps.push(g.s); activeGates.push(g); }
  }
  if (finishGate) {
    corridor.group.remove(finishGate.grp);
    finishGate.grp.traverse(o => { if (o.geometry && o.geometry !== finishGate.pylG) o.geometry.dispose(); });
  }
  finishGate = corridor.buildGate(finishS, 0x66ff7a);

  const c = routeSample(spawnS);
  const own = ROUTE.pts[c.idx].ownOff; // em mão dupla, nasce no lado próprio
  player.x = c.x + -c.dz * own; player.z = c.z + c.dx * own;
  player.h = Math.atan2(c.dx, c.dz);
  player.vx = player.vz = 0;
  player.hint = c.idx; player.nos = 100; player.steer = 0; player.nosArmed = false;
  camPos.set(player.x - Math.sin(player.h) * 9, c.y + 4, player.z - Math.cos(player.h) * 9);
  raceTime = 0; nextCp = 0;
  stunT = 0; stunSpin = 0; crashImmunity = 0;
  trafPh1 = Math.random() * 9; trafPh2 = Math.random() * 9;
  // contra-relógio calibrado por trecho/carro/tráfego (após sortear as fases)
  noTimer = DIFF_LEVELS[diffIdx].m === 0;
  cpGrants = [];
  if (noTimer) {
    timeLeft = 0;
  } else {
    const margin = DIFF_LEVELS[diffIdx].m;
    const pace = computePace(spawnS, finishS);
    const marks = [...cps, finishS];
    timeLeft = Math.max(8, (pace.tAt(marks[0]) - pace.tAt(spawnS)) * margin + 4);
    for (let i = 0; i < cps.length; i++)
      cpGrants.push(Math.max(5, Math.round(
        (pace.tAt(marks[i + 1]) - pace.tAt(marks[i])) * margin)));
  }
  const nAtivos = TRAF_LEVELS[trafIdx].c;
  const tLo = raceS0 + 120, tHi = Math.min(finishS + 800, ROUTE.total - 150);
  traffic.forEach((t, i) => {
    t.active = i < nAtivos;
    t.mesh.visible = t.active;
    t.s = randomTrafficS(tLo, tHi);
    const idx = sampleOf(ROUTE, t.s).idx;
    t.dir = (!t.moto && ROUTE.pts[idx].onc > 0 && Math.random() < 0.45) ? -1 : 1;
    t.li = (Math.random() * 5) | 0;
    t.v = t.moto ? motoSpeed() : carSpeed();
    t.off = null;
    t.wreck = null;
    t.mesh.rotation.set(0, 0, 0);
    t.mesh.position.y = 0;
    if (!t.active) t.mesh.position.set(0, -50, 0);
  });
  endPursuit(false);
  ghostRec = []; ghostRecT = 0;
  loadGhost();
  hideTelas();
  state = 'count'; countT = 3.5;
}

// ================================================================ ghost
// sombra do melhor tempo já corrido neste cenário exato
let ghostRec = [], ghostRecT = 0;
let ghostData = null, ghostCar = null, ghostIdx = 0;

function ghostKey() { return 'rmw_ghost::' + lbKey(); } // lbKey já traz a versão

function loadGhost() {
  try { ghostData = JSON.parse(localStorage.getItem(ghostKey())); }
  catch (e) { ghostData = null; }
  if (ghostCar) { scene.remove(ghostCar); ghostCar = null; }
  ghostIdx = 0;
  if (ghostData && ghostData.smp && ghostData.smp.length > 1) {
    ghostCar = buildPlayerCar(CARS[ghostData.car] || spec);
    ghostCar.traverse(o => {
      if (o.material) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.38;
        o.material.depthWrite = false;
      }
    });
    scene.add(ghostCar);
  } else {
    ghostData = null;
  }
}

function stepGhost() {
  if (!ghostCar || !ghostData) return;
  const smp = ghostData.smp;
  const t = raceTime;
  while (ghostIdx < smp.length - 2 && smp[ghostIdx + 1][0] <= t) ghostIdx++;
  const a = smp[ghostIdx], b = smp[Math.min(ghostIdx + 1, smp.length - 1)];
  const f = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
  const s = a[1] + (b[1] - a[1]) * f;
  const lat = a[2] + (b[2] - a[2]) * f;
  const c = routeSample(s);
  ghostCar.position.set(c.x + -c.dz * lat, c.y, c.z + c.dx * lat);
  ghostCar.rotation.y = Math.atan2(c.dx, c.dz);
}

function maybeSaveGhost() {
  const bestT = ghostData ? ghostData.t : Infinity;
  if (raceTime >= bestT || ghostRec.length < 3) return;
  let smp = ghostRec;
  while (smp.length > 2600) smp = smp.filter((_, i) => i % 2 === 0);
  try {
    localStorage.setItem(ghostKey(),
      JSON.stringify({ t: +raceTime.toFixed(1), car: carIdx, smp }));
  } catch (e) { /* localStorage cheio: segue sem ghost */ }
}

function backToMenu() {
  endPursuit(false);
  state = 'intro';
  hideTelas();
  document.getElementById('intro').style.display = 'flex';
  document.getElementById('nameRow').style.display = 'none';
  player.vx = player.vz = 0;
  renderMenu();
  renderLBs();
}

function hideTelas() {
  paused = false;
  for (const id of ['intro', 'fim', 'fail', 'pause'])
    document.getElementById(id).style.display = 'none';
}

// ================================================================ menu / leaderboard
let menuRow = 0;
const MENU_ROWS = ['rowCar', 'rowTraf', 'rowAcc', 'rowPol', 'rowDiff', 'rowStart', 'rowEnd'];
function renderMenu() {
  document.getElementById('carName').textContent = CARS[carIdx].name;
  document.getElementById('carDesc').textContent = CARS[carIdx].cat;
  document.getElementById('trafName').textContent = TRAF_LEVELS[trafIdx].n;
  document.getElementById('trafDesc').textContent = TRAF_LEVELS[trafIdx].d;
  document.getElementById('accName').textContent = accelAuto ? 'AUTOMÁTICA' : 'MANUAL';
  document.getElementById('accDesc').textContent = accelAuto
    ? 'o carro acelera sozinho — S/↓ freia' : 'segure W/↑ para acelerar';
  document.getElementById('polName').textContent = policeOn ? 'ATIVADA' : 'DESATIVADA';
  document.getElementById('polDesc').textContent = policeOn
    ? 'bateu em alguém? fuja da viatura ou seja preso' : 'corra em paz, sem sirenes';
  const dl = DIFF_LEVELS[diffIdx];
  document.getElementById('diffName').textContent = dl.n;
  document.getElementById('diffDesc').textContent = dl.d +
    (dl.m ? ` · ${Math.round((dl.m - 1) * 100)}% de folga sobre o tempo ideal` : '');
  document.getElementById('startName').textContent = RACE_POINTS[wpStart].n;
  document.getElementById('endName').textContent = RACE_POINTS[wpEnd].n;
  const race = resolveRace(wpStart, wpEnd);
  document.getElementById('endDesc').textContent = race
    ? (race.dist / 1000).toFixed(1).replace('.', ',') + ' km de corrida'
    : 'trajeto indisponível';
  MENU_ROWS.forEach((id, i) =>
    document.getElementById(id).className = 'mrow' + (menuRow === i ? ' sel' : ''));
}

// agrupado por carro + trânsito + trajeto + polícia + dificuldade
// (prefixo novo: leaderboards antigos ficam órfãos = "limpos")
function lbKey() {
  // o token ::v<GAME_VERSION>:: faz a versão da mecânica fazer parte da chave,
  // então qualquer bump de versão reseta os leaderboards (e os ghosts)
  return 'rmw_lb::v' + GAME_VERSION + '::' + CARS[carIdx].name + '::' + TRAF_LEVELS[trafIdx].n +
    '::' + RACE_POINTS[wpStart].n + '>' + RACE_POINTS[wpEnd].n +
    '::POL' + (policeOn ? 1 : 0) + '::' + DIFF_LEVELS[diffIdx].n;
}
function loadLB() {
  try { return JSON.parse(localStorage.getItem(lbKey())) || []; }
  catch (e) { return []; }
}
function fmtT(t) {
  const m = Math.floor(t / 60);
  return m + ':' + (t % 60).toFixed(1).padStart(4, '0');
}
function renderLBs(hl) {
  const lb = loadLB();
  const titulo = `<b>MAIS PROCURADOS &mdash; ${CARS[carIdx].name.toUpperCase()} &middot; ${TRAF_LEVELS[trafIdx].n} &middot; ${RACE_POINTS[wpStart].n.toUpperCase()} &rarr; ${RACE_POINTS[wpEnd].n.toUpperCase()} &middot; ${policeOn ? 'COM' : 'SEM'} POL&Iacute;CIA &middot; ${DIFF_LEVELS[diffIdx].n}</b><br>`;
  const html = lb.length
    ? titulo + lb.map((e, i) =>
        `<span class="${hl !== undefined && Math.abs(e.t - hl) < 0.05 ? 'me' : ''}">` +
        `${i + 1}. ${e.name} &mdash; ${fmtT(e.t)}</span>`).join('<br>')
    : titulo + '<span style="opacity:.5">ainda sem tempos — seja o primeiro</span>';
  document.getElementById('lbIntro').innerHTML = html;
  document.getElementById('lbWin').innerHTML = html;
}
function submitName() {
  const inp = document.getElementById('nameInput');
  const name = (inp.value.trim() || 'PILOTO').toUpperCase().slice(0, 12);
  const lb = loadLB();
  lb.push({ name, t: +raceTime.toFixed(1) });
  lb.sort((a, b) => a.t - b.t);
  localStorage.setItem(lbKey(), JSON.stringify(lb.slice(0, 5)));
  document.getElementById('nameRow').style.display = 'none';
  renderLBs(raceTime);
}
document.getElementById('nameInput').addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.code === 'Enter') submitName();
});

// ================================================================ entrada
const keys = {};
addEventListener('keydown', e => {
  if (e.target && e.target.tagName === 'INPUT') return;
  keys[e.code] = true;
  if (state === 'intro') {
    if (e.code === 'ArrowUp' || e.code === 'KeyW') {
      menuRow = (menuRow + MENU_ROWS.length - 1) % MENU_ROWS.length; renderMenu();
    }
    if (e.code === 'ArrowDown' || e.code === 'KeyS') {
      menuRow = (menuRow + 1) % MENU_ROWS.length; renderMenu();
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'KeyA' || e.code === 'KeyD') {
      const d = (e.code === 'ArrowLeft' || e.code === 'KeyA') ? -1 : 1;
      const nP = RACE_POINTS.length;
      if (menuRow === 0) { carIdx = (carIdx + d + CARS.length) % CARS.length; applyCar(); }
      else if (menuRow === 1) {
        trafIdx = (trafIdx + d + TRAF_LEVELS.length) % TRAF_LEVELS.length;
        localStorage.setItem('rmw_traf', String(trafIdx));
      } else if (menuRow === 2) {
        accelAuto = !accelAuto;
        localStorage.setItem('rmw_auto', accelAuto ? '1' : '0');
      } else if (menuRow === 3) {
        policeOn = !policeOn;
        localStorage.setItem('rmw_police', policeOn ? '1' : '0');
      } else if (menuRow === 4) {
        diffIdx = (diffIdx + d + DIFF_LEVELS.length) % DIFF_LEVELS.length;
        localStorage.setItem('rmw_diff', String(diffIdx));
      } else if (menuRow === 5) {
        // próxima largada que tenha alguma chegada válida
        for (let k = 0; k < nP; k++) {
          wpStart = (wpStart + d + nP) % nP;
          if (RACE_POINTS.some((_, j) => resolveRace(wpStart, j))) break;
        }
        if (!resolveRace(wpStart, wpEnd)) {
          for (let k = 0; k < nP; k++) {
            wpEnd = (wpEnd + 1) % nP;
            if (resolveRace(wpStart, wpEnd)) break;
          }
        }
        localStorage.setItem('rmw_startn', RACE_POINTS[wpStart].n);
        localStorage.setItem('rmw_endn', RACE_POINTS[wpEnd].n);
      } else if (menuRow === 6) {
        for (let k = 0; k < nP; k++) {
          wpEnd = (wpEnd + d + nP) % nP;
          if (resolveRace(wpStart, wpEnd)) break;
        }
        localStorage.setItem('rmw_endn', RACE_POINTS[wpEnd].n);
      }
      renderMenu();
      renderLBs();
    }
  }
  if (e.code === 'Escape' && state !== 'intro') backToMenu();
  if (e.code === 'Enter' && state === 'intro') { initAudio(); resetGame(); }
  if (e.code === 'KeyR' && state !== 'intro') { initAudio(); resetGame(); }
  if (e.code === 'KeyC') camMode = 1 - camMode;
  if (e.code === 'KeyM') muted = !muted;
  if (e.code === 'KeyP' && state === 'race') {
    paused = !paused;
    document.getElementById('pause').style.display = paused ? 'flex' : 'none';
    if (paused && actx) { // silencia motor e sirene na pausa
      oscGain.gain.setTargetAtTime(0, actx.currentTime, 0.05);
      if (sirenGain) sirenGain.gain.setTargetAtTime(0, actx.currentTime, 0.05);
    }
  }
  if (e.code === 'F2' || e.code === 'KeyB') { // DEBUG: monitor da perseguição
    DEBUG = !DEBUG;
    document.getElementById('dbg').style.display = DEBUG ? 'block' : 'none';
    e.preventDefault();
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => keys[e.code] = false);

// ================================================================ som
let actx = null, osc = null, oscGain = null, sirenOsc = null, sirenGain = null;
function initAudio() {
  if (actx) return;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    osc = actx.createOscillator(); osc.type = 'sawtooth';
    const filt = actx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 900;
    oscGain = actx.createGain(); oscGain.gain.value = 0;
    osc.connect(filt); filt.connect(oscGain); oscGain.connect(actx.destination);
    osc.start();
    sirenOsc = actx.createOscillator(); sirenOsc.type = 'square';
    const sf = actx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 2200;
    sirenGain = actx.createGain(); sirenGain.gain.value = 0;
    sirenOsc.connect(sf); sf.connect(sirenGain); sirenGain.connect(actx.destination);
    sirenOsc.start();
  } catch (e) { /* sem áudio */ }
}
function updateAudio(speed, nosOn) {
  if (!actx) return;
  const gearStep = spec.vmax / 6;
  const gear = Math.min(5, Math.floor(Math.abs(speed) / gearStep));
  const rpm = (Math.abs(speed) - gear * gearStep) / gearStep;
  // em velocidade de cruzeiro (vmax sem nitro) o motor "assenta" e fica baixo
  const cruise = !nosOn && Math.abs(speed) > spec.vmax * 0.93 ? 0.42 : 1;
  osc.frequency.setTargetAtTime(64 + rpm * 150 + gear * 10 + (nosOn ? 30 : 0), actx.currentTime, 0.05);
  oscGain.gain.setTargetAtTime(muted || state === 'intro' ? 0
    : (0.045 + rpm * 0.05 + Math.abs(speed) * 0.0006) * cruise, actx.currentTime, 0.08);
}
function updateSiren(intensity) {
  if (!actx || !sirenOsc) return;
  const t = performance.now() / 1000;
  sirenOsc.frequency.setTargetAtTime((Math.floor(t * 2.4) % 2) ? 950 : 640,
    actx.currentTime, 0.03);
  sirenGain.gain.setTargetAtTime(muted ? 0 : intensity * 0.085, actx.currentTime, 0.1);
}
function crashSound() {
  if (!actx || muted) return;
  const len = actx.sampleRate * 0.35;
  const buf = actx.createBuffer(1, len, actx.sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < len; i++)
    ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2);
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
  const g = actx.createGain(); g.gain.value = 0.5;
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start();
}
function cpSound() {
  if (!actx || muted) return;
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = 'square'; o.frequency.value = 880;
  g.gain.setValueAtTime(0.08, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.25);
  o.connect(g); g.connect(actx.destination);
  o.start(); o.stop(actx.currentTime + 0.25);
}

// ================================================================ HUD
const elVel = document.querySelector('#vel .num');
const elNos = document.getElementById('nosfill');
const elTempo = document.getElementById('tempo');
const elCp = document.getElementById('cpinfo');
const elMsg = document.getElementById('msg');
const elFlash = document.getElementById('flash');
const elLocal = document.getElementById('local');
let msgT = 0;
function showMsg(t, dur = 1.6) {
  elMsg.textContent = t; elMsg.style.opacity = 1; msgT = dur;
}
function flash() {
  elFlash.style.opacity = 1;
  setTimeout(() => elFlash.style.opacity = 0, 120);
}

const PLACES = MAP_DATA.places || [];
let localT = 0, localName = '';
function updateLocal(dt, s) {
  localT -= dt;
  if (localT > 0) return;
  localT = 0.5;
  let name = 'RIO DE JANEIRO';
  const tun = ROUTE.tunnels.find(t => t[1] - t[0] > 300 && s >= t[0] - 30 && s <= t[1] + 30);
  if (tun && tun[2] && tun[2] !== 'Linha Amarela') {
    name = tun[2].replace('Engenheiro', 'Eng.').toUpperCase();
  } else {
    let bd = 2600, best = null;
    for (const p of PLACES) {
      const d = Math.hypot(p.p[0] - player.x, p.p[1] - player.z);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) name = best.n.toUpperCase();
  }
  if (name !== localName) {
    localName = name;
    elLocal.textContent = name + ' · RIO DE JANEIRO';
  }
}

// ================================================================ minimapa
const mm = document.getElementById('minimapa');
const mmCtx = mm.getContext('2d');
const mmBase = document.createElement('canvas');
const mmFull = document.createElement('canvas');
const MM = (() => {
  let minX = 1e18, maxX = -1e18, minZ = 1e18, maxZ = -1e18;
  for (const R of ROUTES)
    for (const p of R.pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
  minX -= 3000; maxX += 3000; minZ -= 3000; maxZ += 3000;
  const ext = Math.max(maxX - minX, maxZ - minZ);
  const SIZE = 3400;
  mmBase.width = mmBase.height = SIZE;
  mmFull.width = mmFull.height = SIZE;
  const sc = SIZE / ext;
  const toPx = (x, z) => [(x - minX) * sc, (z - minZ) * sc];
  const ctx = mmBase.getContext('2d');
  ctx.fillStyle = '#10140f'; ctx.fillRect(0, 0, SIZE, SIZE);
  const ROADC = { lk: '#4a4e4c', pr: '#585d5b', tr: '#6d7270', mw: '#8a8f8c', la: '#8a7a40' };
  for (const pass of ['pr', 'lk', 'tr', 'mw', 'la']) {
    ctx.strokeStyle = ROADC[pass];
    ctx.lineWidth = pass === 'pr' ? 1.1 : 1.8;
    ctx.beginPath();
    for (const rd of MAP_DATA.roads) {
      if (rd.t !== pass) continue;
      const [x0, z0] = toPx(rd.p[0][0], rd.p[0][1]);
      ctx.moveTo(x0, z0);
      for (let i = 1; i < rd.p.length; i++) {
        const [x, z] = toPx(rd.p[i][0], rd.p[i][1]);
        ctx.lineTo(x, z);
      }
    }
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,.75)';
  ctx.font = '13px Arial';
  for (const lb of MAP_DATA.labels) {
    const [x, z] = toPx(lb.p[0], lb.p[1]);
    ctx.fillText(lb.n, x + 4, z - 4);
  }
  ctx.textAlign = 'center';
  ctx.font = 'bold 12px Arial';
  for (const p of PLACES) {
    if (!['suburb', 'town', 'village'].includes(p.t)) continue;
    const [x, z] = toPx(p.p[0], p.p[1]);
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillText(p.n, x + 1, z + 1);
    ctx.fillStyle = 'rgba(240,230,195,.92)';
    ctx.fillText(p.n, x, z);
  }
  ctx.textAlign = 'left';
  return { toPx, sc };
})();

function bakeRouteOverlay() {
  const ctx = mmFull.getContext('2d');
  ctx.clearRect(0, 0, mmFull.width, mmFull.height);
  ctx.drawImage(mmBase, 0, 0);
  ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 3.2; ctx.beginPath();
  const [x0, z0] = MM.toPx(ROUTE.pts[0].x, ROUTE.pts[0].z);
  ctx.moveTo(x0, z0);
  for (let i = 1; i < ROUTE.pts.length; i += 2) {
    const [x, z] = MM.toPx(ROUTE.pts[i].x, ROUTE.pts[i].z);
    ctx.lineTo(x, z);
  }
  ctx.stroke();
}

function drawMinimap() {
  const [px, pz] = MM.toPx(player.x, player.z);
  const W = 240;
  mmCtx.clearRect(0, 0, W, W);
  mmCtx.drawImage(mmFull, px - W / 2, pz - W / 2, W, W, 0, 0, W, W);
  const cpS = nextCp < cps.length ? cps[nextCp] : finishS;
  const c = routeSample(cpS);
  const [cx, cz] = MM.toPx(c.x, c.z);
  if (Math.floor(performance.now() / 350) % 2 === 0) {
    mmCtx.fillStyle = nextCp < cps.length ? '#ffd34d' : '#66ff7a';
    mmCtx.beginPath();
    mmCtx.arc(cx - px + W / 2, cz - pz + W / 2, 5, 0, Math.PI * 2);
    mmCtx.fill();
  }
  mmCtx.save();
  mmCtx.translate(W / 2, W / 2);
  mmCtx.rotate(Math.PI - player.h);
  mmCtx.fillStyle = '#ff9a20';
  mmCtx.beginPath();
  mmCtx.moveTo(0, -8); mmCtx.lineTo(5.5, 6); mmCtx.lineTo(-5.5, 6);
  mmCtx.closePath(); mmCtx.fill();
  mmCtx.restore();
}

// ================================================================ física
function stepPlayer(dt) {
  const VMAX = spec.vmax, VMAX_NOS = spec.vmax + 13;
  const fX = Math.sin(player.h), fZ = Math.cos(player.h);
  const rX = fZ, rZ = -fX;
  let fwd = player.vx * fX + player.vz * fZ;
  let lat = player.vx * rX + player.vz * rZ;

  const stunned = stunT > 0;
  const dn = !stunned && (keys.KeyS || keys.ArrowDown);
  const up = !stunned && (keys.KeyW || keys.ArrowUp ||
    (accelAuto && state === 'race' && !dn));
  const lf = !stunned && (keys.KeyA || keys.ArrowLeft);
  const rt = !stunned && (keys.KeyD || keys.ArrowRight);
  const hb = !stunned && keys.Space;
  // nitro travado (anti-feathering): só ARMA quando carrega até NOS_ARM%; uma
  // vez armado pode usar até zerar; ao esvaziar, desarma e recarrega do zero
  const wantNos = !stunned && (keys.ShiftLeft || keys.ShiftRight) && fwd > 5 && state === 'race';
  if (!player.nosArmed && wantNos && player.nos >= NOS_ARM) player.nosArmed = true;
  const nosOn = player.nosArmed && wantNos && player.nos > 0;
  if (stunned) {
    stunT -= dt;
    player.h += stunSpin * dt;
    stunSpin *= Math.exp(-2.5 * dt);
    fwd *= Math.exp(-1.4 * dt);
  }
  if (crashImmunity > 0) crashImmunity -= dt;

  const vmax = nosOn ? VMAX_NOS : VMAX;
  if (state === 'race') {
    if (up && fwd < vmax) fwd = Math.min(vmax, fwd + (nosOn ? spec.acc * 1.8 : spec.acc) * Math.max(0.15, 1 - fwd / vmax) * dt);
    if (dn) fwd -= (fwd > 0.5 ? 26 : 9) * dt;
    if (!up && !dn) fwd -= Math.sign(fwd) * 1.1 * dt;
    // a sobre-velocidade do nitro desce bem devagar (coast ~2.5 m/s²): ela
    // PERSISTE alguns segundos após o tanque, então o nitro abre distância de
    // verdade e a fuga fica possível. Cortar na hora (como antes) zerava o ganho.
    if (fwd > vmax) fwd = Math.max(vmax, fwd - 2.5 * dt);
    fwd = Math.max(-13, fwd);
    if (nosOn) {
      player.nos = Math.max(0, player.nos - 22 * dt); // usando: drena
      if (player.nos <= 0) { player.nos = 0; player.nosArmed = false; }
    } else {
      // soltou (ou esvaziou): desarma e SEMPRE recarrega — parou de usar antes
      // de acabar? o tanque volta a encher (e precisa atingir 50% p/ rearmar)
      player.nosArmed = false;
      player.nos = Math.min(100, player.nos + 9 * dt);
    }
  } else if (state !== 'count') {
    fwd *= Math.exp(-1.2 * dt);
  }
  if (hb) fwd -= Math.sign(fwd) * 4.5 * dt;

  const target = (lf ? -1 : 0) + (rt ? 1 : 0);
  player.steer += (target - player.steer) * Math.min(1, 9 * dt);
  const spd = Math.abs(fwd);
  const yawGain = 2.6 * spec.yaw * Math.min(1, spd / 9) / (1 + spd * 0.028) * (hb ? 1.55 : 1);
  // h crescente vira à esquerda (forward = (sin h, cos h)) -> D diminui h
  player.h -= player.steer * yawGain * dt * Math.sign(fwd || 1);

  const grip = hb ? 1.15 : spec.grip;
  lat *= Math.exp(-grip * dt);

  const nfX = Math.sin(player.h), nfZ = Math.cos(player.h);
  const nrX = nfZ, nrZ = -nfX;
  player.vx = nfX * fwd + nrX * lat;
  player.vz = nfZ * fwd + nrZ * lat;
  player.x += player.vx * dt;
  player.z += player.vz * dt;

  // colisão com as defensas (limite varia com o nº de faixas local)
  const c = routeClosest(player.x, player.z, player.hint);
  player.hint = c.idx;
  const wallLat = ROUTE.pts[c.idx].wall;
  // contenção: se escapou do corredor (fuga tangente em quina/alça),
  // recoloca na pista apontando na direção certa
  if (Math.sqrt(c.d2) > ROUTE.pts[c.idx].half + 7) {
    player.x = c.qx; player.z = c.qz;
    const spd0 = Math.hypot(player.vx, player.vz) * 0.4;
    player.vx = c.dx * spd0; player.vz = c.dz * spd0;
    player.h = Math.atan2(c.dx, c.dz);
    flash();
  }
  if (Math.abs(c.lat) > wallLat) {
    const over = Math.abs(c.lat) - wallLat;
    const sgn = Math.sign(c.lat);
    player.x -= c.rX * sgn * over;
    player.z -= c.rZ * sgn * over;
    const vLat = player.vx * c.rX + player.vz * c.rZ;
    const impact = vLat * sgn;
    if (impact > 0) {
      const bounce = impact > 6 ? 1.35 : 1.02;
      player.vx -= c.rX * vLat * bounce;
      player.vz -= c.rZ * vLat * bounce;
      if (impact > 6) { flash(); player.vx *= 0.88; player.vz *= 0.88; }
      else if (impact > 2.5) { player.vx *= 0.985; player.vz *= 0.985; }
    }
  }

  // acostamento: espremer-se entre o tráfego e a defensa arrasta o carro
  // (zona além da borda externa das faixas reais)
  const pAt = ROUTE.pts[c.idx];
  const shoulder = Math.abs(c.lat) > (pAt.ln + pAt.onc) * 1.8 - 0.1;
  if (shoulder && state === 'race' && Math.hypot(player.vx, player.vz) > 9) {
    const fr = Math.exp(-1.5 * dt);
    player.vx *= fr; player.vz *= fr;
  }

  // tráfego — hitbox orientada (mais justa: "tirar fino" não conta)
  for (const t of traffic) {
    if (!t.active) continue;
    const dx = player.x - t.mesh.position.x, dz = player.z - t.mesh.position.z;
    if (dx * dx + dz * dz > 40) continue;
    const th = t.mesh.rotation.y;
    const tfx = Math.sin(th), tfz = Math.cos(th);
    const along = dx * tfx + dz * tfz;
    const side = dx * tfz - dz * tfx;
    // moto é estreita: hitbox bem menor
    if (Math.abs(along) > (t.moto ? 2.5 : 3.9) ||
        Math.abs(side) > (t.moto ? 0.95 : 1.6)) continue;

    const d = Math.hypot(dx, dz) || 0.01;
    const nx = dx / d, nz = dz / d;
    const push = Math.max(0, 3.0 - d);
    player.x += nx * push; player.z += nz * push;

    const tvx = (t.wreck ? 0 : tfx * t.v), tvz = (t.wreck ? 0 : tfz * t.v);
    const rel = Math.hypot(player.vx - tvx, player.vz - tvz);

    if (rel > 13 && crashImmunity <= 0) {
      if (!t.wreck) t.wreck = {
        t: 0, y: 0,
        wy: 4.5 + rel * 0.12,
        vx: player.vx * 0.65 + nx * -4, vz: player.vz * 0.65 + nz * -4,
        rx: (Math.random() * 2 - 1) * 6, rz: (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 4),
      };
      stunT = 1.15;
      stunSpin = (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random());
      crashImmunity = 2.0;
      player.vx *= 0.30; player.vz *= 0.30;
      flash();
      showMsg('BATIDA!', 1.2);
      crashSound();
      startPursuit(c.s); // bateu? a polícia vem atrás
    } else {
      player.vx = player.vx * 0.985 + nx * 1.2;
      player.vz = player.vz * 0.985 + nz * 1.2;
    }
  }

  // progresso / checkpoints
  if (state === 'race') {
    raceTime += dt;
    if (!noTimer) timeLeft -= dt;
    const cpS = nextCp < cps.length ? cps[nextCp] : finishS;
    if (c.s >= cpS && Math.abs(c.lat) < ROUTE.pts[c.idx].half + 3) {
      if (nextCp < cps.length) {
        activeGates[nextCp].mat.opacity = 0.12;
        if (noTimer) {
          showMsg('CHECKPOINT');
        } else {
          const tb = cpGrants[nextCp] || 20;
          timeLeft += tb;
          showMsg('CHECKPOINT  +' + tb + 's');
        }
        nextCp++;
        cpSound();
      } else {
        state = 'win';
        endPursuit(false); // cruzou a chegada: a polícia ficou para trás
        maybeSaveGhost();
        document.getElementById('fim').style.display = 'flex';
        document.getElementById('chegadaTitulo').textContent =
          'CHEGADA: ' + RACE_POINTS[wpEnd].n.toUpperCase();
        document.getElementById('tempofinal').textContent =
          `TEMPO: ${fmtT(raceTime)}  —  ${raceKm()} km  —  ${CARS[carIdx].name}`;
        const lb = loadLB();
        const qualifica = lb.length < 5 || raceTime < lb[lb.length - 1].t;
        renderLBs();
        if (qualifica) {
          const row = document.getElementById('nameRow');
          row.style.display = 'block';
          const inp = document.getElementById('nameInput');
          inp.value = '';
          setTimeout(() => inp.focus(), 100);
        }
      }
    }
    if (!noTimer && timeLeft <= 0) {
      timeLeft = 0;
      state = 'fail';
      endPursuit(false);
      document.getElementById('failTitle').textContent = 'TEMPO ESGOTADO';
      document.getElementById('failSub').textContent = 'O RELÓGIO VENCEU DESSA VEZ';
      document.getElementById('fail').style.display = 'flex';
      document.getElementById('distfail').textContent =
        `VOCÊ PERCORREU ${((c.s - raceS0) / 1000).toFixed(1)} KM DE ${raceKm()} KM`;
    }
  }

  // visual do carro
  car.position.set(player.x, c.y, player.z);
  car.rotation.y = player.h;
  const ws = car.userData.wheels;
  const roll = fwd * dt / 0.34;
  for (let i = 0; i < 4; i++) ws[i].rotation.x += roll;
  ws[0].rotation.y = ws[1].rotation.y = -player.steer * 0.45;
  car.rotation.z = player.steer * Math.min(1, spd / 30) * 0.05;

  updateAudio(fwd, nosOn);
  return { fwd, c, nosOn, shoulder: shoulder && spd > 9 };
}

// ================================================================ câmera
const camPos = new THREE.Vector3(0, 5, -10);
function stepCamera(dt, fwd, nosOn, surfY, shoulder) {
  const fX = Math.sin(player.h), fZ = Math.cos(player.h);
  let want;
  if (camMode === 0) {
    const dist = 7.6 + Math.abs(fwd) * 0.032;
    want = new THREE.Vector3(player.x - fX * dist, surfY + 3.3 + Math.abs(fwd) * 0.014, player.z - fZ * dist);
  } else {
    want = new THREE.Vector3(player.x + fX * 0.4, surfY + 1.15, player.z + fZ * 0.4);
  }
  const k = 1 - Math.exp(-(camMode === 0 ? 8 : 18) * dt);
  camPos.lerp(want, k);
  if (camMode === 0) {
    const dx = camPos.x - player.x, dz = camPos.z - player.z;
    const d = Math.hypot(dx, dz), dmax = 7.6 + Math.abs(fwd) * 0.032 + 3.5;
    if (d > dmax) {
      camPos.x = player.x + dx / d * dmax;
      camPos.z = player.z + dz / d * dmax;
    }
  }
  camera.position.copy(camPos);
  if (nosOn) {
    camera.position.x += (Math.random() - 0.5) * 0.12;
    camera.position.y += (Math.random() - 0.5) * 0.12;
  }
  if (stunT > 0) {
    camera.position.x += (Math.random() - 0.5) * 0.5;
    camera.position.y += (Math.random() - 0.5) * 0.5;
  }
  if (shoulder) { // zebra/acostamento: trepidação
    camera.position.x += (Math.random() - 0.5) * 0.14;
    camera.position.y += (Math.random() - 0.5) * 0.14;
  }
  camera.lookAt(player.x + fX * 11, surfY + 1.0, player.z + fZ * 11);
  const wantFov = 62 + Math.abs(fwd) / spec.vmax * 14 + (nosOn ? 9 : 0);
  camera.fov += (wantFov - camera.fov) * Math.min(1, 6 * dt);
  camera.updateProjectionMatrix();
}

// ================================================================ loop
let lastT = performance.now();

// boot: corredor padrão + carro na largada
{
  selectRoute(resolveRace(wpStart, wpEnd).R);
  const c = routeSample(40);
  player.x = c.x; player.z = c.z;
  player.h = Math.atan2(c.dx, c.dz);
  player.hint = c.idx;
  car.position.set(c.x, c.y, c.z);
  car.rotation.y = player.h;
  camPos.set(c.x - Math.sin(player.h) * 9, c.y + 4, c.z - Math.cos(player.h) * 9);
  renderMenu();
  renderLBs();
  const nTerm = [...new Set(ROUTES.flatMap(R => [R.from, R.to]))].length;
  document.getElementById('subtitulo').innerHTML =
    `${nTerm} TERMINAIS REAIS &nbsp;&bull;&nbsp; DE MURIQUI AO FUND&Atilde;O &nbsp;&bull;&nbsp; ESCOLHA SEU TRAJETO`;
}

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (paused && state === 'race') { // congela física/relógio; só renderiza
    renderer.render(scene, camera);
    return;
  }

  if (state === 'count') {
    countT -= dt;
    const n = Math.ceil(countT - 0.5);
    if (countT <= 0.5) { state = 'race'; showMsg('GO!', 0.9); }
    else showMsg(String(n), 0.4);
  }

  const r = stepPlayer(dt);
  stepTraffic(dt, r.c.s);
  stepPolice(dt, r.c.s, r.c.lat, Math.hypot(player.vx, player.vz));
  stepCamera(dt, r.fwd, r.nosOn, r.c.y, r.shoulder);
  updateLocal(dt, r.c.s);
  // grava e reproduz a sombra do melhor tempo
  if (state === 'race') {
    ghostRecT += dt;
    if (ghostRecT > 0.4) {
      ghostRecT = 0;
      ghostRec.push([+raceTime.toFixed(2), Math.round(r.c.s), +r.c.lat.toFixed(1)]);
    }
    stepGhost();
  }

  elVel.textContent = Math.round(Math.abs(r.fwd) * 3.6);
  elNos.style.width = player.nos + '%';
  // cor da barra: em uso=azul, pronto p/ armar (>=50%)=verde, carregando=cinza
  elNos.style.background = player.nosArmed
    ? 'linear-gradient(90deg,#2da8ff,#9fe2ff)'
    : (player.nos >= NOS_ARM ? 'linear-gradient(90deg,#3ad17a,#9fffba)'
                             : 'linear-gradient(90deg,#7a7a7a,#a9a9a9)');
  if (state === 'race' || state === 'count') {
    if (noTimer) {
      elTempo.textContent = fmtT(raceTime);
      elTempo.className = '';
    } else {
      elTempo.textContent = timeLeft.toFixed(1);
      elTempo.className = timeLeft < 10 ? 'pouco' : '';
    }
    const cpS = nextCp < cps.length ? cps[nextCp] : finishS;
    const dist = Math.max(0, cpS - r.c.s);
    elCp.textContent = (nextCp < cps.length
      ? `CHECKPOINT ${nextCp + 1}/${cps.length}`
      : 'CHEGADA: ' + RACE_POINTS[wpEnd].n.toUpperCase()) + ` · ${Math.round(dist)} m`;
  }
  if (msgT > 0) { msgT -= dt; if (msgT <= 0) elMsg.style.opacity = 0; }

  if (DEBUG) updateDebug(r);

  drawMinimap();
  renderer.render(scene, camera);
}
// ---- HUD de DEBUG da perseguição (F2 / B alterna) ----
const elDbg = document.getElementById('dbg');
function updateDebug(r) {
  if (elDbg.style.display !== 'block') elDbg.style.display = 'block';
  const kmh = (Math.hypot(player.vx, player.vz) * 3.6) | 0;
  const nosOn = (keys.ShiftLeft || keys.ShiftRight) && player.nos > 0;
  let s = `build ${GAME_VERSION}  ${DIFF_LEVELS[diffIdx].n}  ${CARS[carIdx].name}\n`;
  s += `vel ${kmh} km/h   nitro ${player.nos.toFixed(0)}%${nosOn ? ' [ON]' : ''}\n`;
  if (pursuit) {
    const gap = pursuit.nearGap === undefined ? 0 : pursuit.nearGap;
    const pcKmh = ((pursuit.pcSpd || 0) * 3.6) | 0;
    const ate = Math.max(0, ESCAPE_DIST - gap);
    const escPct = ((pursuit.escapeT / ESCAPE_HOLD) * 100) | 0;
    const catchPct = ((pursuit.catchT / CATCH_HOLD) * 100) | 0;
    s += `--- PERSEGUICAO (${pursuit.n} viaturas) ---\n`;
    s += pursuit.grace > 0 ? `GRACE ${pursuit.grace.toFixed(1)}s (recuperando, nada conta)\n`
                           : `gap ${gap.toFixed(0)}m   viatura ${pcKmh} km/h\n`;
    s += `FUGA: precisa gap > ${ESCAPE_DIST}m por ${ESCAPE_HOLD}s\n`;
    s += `  falta abrir: ${ate.toFixed(0)}m   contador fuga: ${escPct}%\n`;
    s += `PRISAO: gap < ${CATCH_DIST}m por ${CATCH_HOLD}s   contador: ${catchPct}%`;
  } else {
    s += `--- sem perseguicao (bata em um carro p/ iniciar) ---`;
  }
  elDbg.textContent = s;
}

frame();

// exposição para depuração/testes automatizados
window.__DBG = { player, keys, routeClosest, routeSample, scene, camera, THREE, traffic,
  ROUTES, RACE_POINTS, resolveRace, startPursuit, policeCars,
  get pursuit() { return pursuit; },
  get spec() { return spec; },
  get diffIdx() { return diffIdx; },
  get cpGrants() { return cpGrants; },
  get noTimer() { return noTimer; },
  get ROUTE() { return ROUTE; },
  get state() { return state; }, get timeLeft() { return timeLeft; },
  get nextCp() { return nextCp; } };

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
