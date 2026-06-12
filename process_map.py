# -*- coding: utf-8 -*-
"""Processa dados OSM brutos em map_data.js para o jogo.

v5 — malha bidirecional com 3 terminais (Recreio, Jardim Oceânico, Fundão):
- 6 rotas direcionais (pares ordenados de terminais) via Dijkstra ponderado
  por classe de via (vias expressas custam menos -> segue a Linha Amarela)
- por ponto da rota: flags de túnel, nº de faixas (tag lanes) e ponte (bridge)
- por rota: saídas numeradas da Linha Amarela, túneis nomeados, pedágio
- projeta lat/lon para metros locais (x=leste, z=sul; norte=-z, Three.js)
"""
import json
import math
import heapq

KX = 102000.0  # m/grau lon na latitude do Rio
KY = 110540.0  # m/grau lat


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def seglen(g):
    return sum(math.hypot((b['lon'] - a['lon']) * KX, (b['lat'] - a['lat']) * KY)
               for a, b in zip(g, g[1:]))


def project(lat, lon, lat0, lon0):
    kx = 111320.0 * math.cos(math.radians(lat0))
    return ((lon - lon0) * kx, -(lat - lat0) * KY)


def simplify(pts, tol):
    """Douglas-Peucker em 2D."""
    if len(pts) < 3:
        return pts
    def d2line(p, a, b):
        ax, ay = a; bx, by = b; px, py = p
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return math.hypot(px - ax, py - ay)
        t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        best, bd = -1, tol
        for k in range(i + 1, j):
            d = d2line(pts[k], pts[i], pts[j])
            if d > bd:
                best, bd = k, d
        if best >= 0:
            keep.append(best)
            stack.append((i, best))
            stack.append((best, j))
    keep.sort()
    return [pts[k] for k in keep]


# ---------- 1. Grafo completo de vias ----------
rd = load('roads_raw.json')
seen_ids = {e['id'] for e in rd['elements'] if e['type'] == 'way'}
for extra in ('ext_barra.json', 'ext_fundao.json', 'ext_praia.json',
              'ext_recreio.json', 'ext_pepe.json', 'ext_costaverde.json'):
    try:
        for e in load(extra)['elements']:
            if e['type'] == 'way' and e['id'] not in seen_ids:
                rd['elements'].append(e)
                seen_ids.add(e['id'])
    except FileNotFoundError:
        print(f'aviso: {extra} ausente')

HW_GRAPH = {'motorway', 'motorway_link', 'trunk', 'trunk_link',
            'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary'}
# fator de custo por classe: o caminho "natural" segue as vias expressas
CLASS_W = {'motorway': 0.82, 'motorway_link': 1.0, 'trunk': 0.95,
           'trunk_link': 1.05, 'primary': 1.25, 'primary_link': 1.3,
           'secondary': 1.6, 'secondary_link': 1.7, 'tertiary': 2.2}

graph = {}      # node -> [(way, to_node, reversed?)]
all_ways = {}
node_coord = {}
for e in rd['elements']:
    if e['type'] != 'way' or 'geometry' not in e:
        continue
    tags = e.get('tags', {})
    if tags.get('highway') not in HW_GRAPH:
        continue
    all_ways[e['id']] = e
    for nid, g in zip(e['nodes'], e['geometry']):
        node_coord[nid] = (g['lat'], g['lon'])
    a, b = e['nodes'][0], e['nodes'][-1]
    oneway = tags.get('oneway', 'yes' if tags['highway'].startswith('motorway') else 'no')
    if oneway == '-1':
        graph.setdefault(b, []).append((e, a, True))
    else:
        graph.setdefault(a, []).append((e, b, False))
        if oneway == 'no':
            graph.setdefault(b, []).append((e, a, True))

la_ways = {wid: w for wid, w in all_ways.items()
           if w['tags'].get('highway') == 'motorway'
           and w['tags'].get('name') == 'Linha Amarela'}
la_nodes = set()
for w in la_ways.values():
    la_nodes.update(w['nodes'])
print(f'{len(all_ways)} vias no grafo, {len(la_ways)} trechos da Linha Amarela')


BEACH_ROADS = {'Avenida Lúcio Costa', 'Avenida do Pepê', 'Avenida Sernambetiba',
               'Avenida Pepê'}

def way_cost(w):
    tags = w.get('tags', {})
    f = CLASS_W.get(tags.get('highway'), 2.0)
    if tags.get('name') == 'Linha Amarela':
        f *= 0.85
    elif tags.get('name') in BEACH_ROADS:
        f *= 0.5  # a orla é o caminho "canônico" entre Recreio e a Barra
    return seglen(w['geometry']) * f


def dijkstra(src, targets):
    """Caminho de menor custo de src a qualquer nó em targets -> (nó, [(way,rev)])."""
    dist = {src: 0.0}
    prev = {}
    pq = [(0.0, src)]
    while pq:
        d, n = heapq.heappop(pq)
        if d > dist.get(n, 1e18):
            continue
        if n in targets and n != src:
            path = []
            cur = n
            while cur != src:
                w, p, rev = prev[cur]
                path.append((w, rev))
                cur = p
            return n, list(reversed(path))
        for w, to, rev in graph.get(n, []):
            nd = d + way_cost(w)
            if nd < dist.get(to, 1e18):
                dist[to] = nd
                prev[to] = (w, n, rev)
                heapq.heappush(pq, (nd, to))
    return None, None


def candidates_near(latq, lonq, radius):
    out = []
    for nid, (la_, lo_) in node_coord.items():
        d = math.hypot((lo_ - lonq) * KX, (la_ - latq) * KY)
        if d < radius and nid in graph:
            out.append((d, nid))
    out.sort()
    return [nid for _, nid in out]


# ---------- 2. Terminais e rotas direcionais ----------
TERMINALS = {
    'Recreio': (-23.0285, -43.4640),
    'Jardim Oceânico': (-23.0080, -43.2980),
    'Fundão': (-22.8425, -43.2330),
    'Muriqui': (-22.9202, -43.9440),
    'Norte Shopping': (-22.8875, -43.2880),
    'Rio 2': (-22.9680, -43.3900),
}
PAIRS = [(a, b) for a in TERMINALS for b in TERMINALS if a != b]
TERM_RADIUS = 1100

raw_routes = {}
for a, b in PAIRS:
    targets = set(candidates_near(*TERMINALS[b], TERM_RADIUS)[:80])
    found = None
    for src in candidates_near(*TERMINALS[a], TERM_RADIUS)[:14]:
        node, path = dijkstra(src, targets)
        if node is not None:
            found = path
            break
    if not found:
        print(f'ROTA {a} -> {b}: NÃO ENCONTRADA')
        continue
    L = sum(seglen(w['geometry']) for w, _ in found)
    raw_routes[(a, b)] = found
    print(f'rota {a} -> {b}: {L/1000:.1f} km, {len(found)} vias')

# centro de projeção: meio da rota Recreio -> Fundão
ref = raw_routes[('Recreio', 'Fundão')]
ref_ll = []
for w, rev in ref:
    g = list(reversed(w['geometry'])) if rev else w['geometry']
    ref_ll.extend((p['lat'], p['lon']) for p in g)
lat0, lon0 = ref_ll[len(ref_ll) // 2]
print(f'centro: {lat0:.5f}, {lon0:.5f}')

# ---------- 3. Pedágio (cabines LAMSA reais) ----------
toll_xz = None
try:
    tl = load('toll_raw.json')
    booths = [(e['lat'], e['lon']) for e in tl['elements']
              if e['type'] == 'node' and e.get('tags', {}).get('operator') == 'LAMSA']
    if booths:
        blat = sum(b[0] for b in booths) / len(booths)
        blon = sum(b[1] for b in booths) / len(booths)
        toll_xz = project(blat, blon, lat0, lon0)
        print(f'pedágio em xz=({toll_xz[0]:.0f}, {toll_xz[1]:.0f})')
except FileNotFoundError:
    pass


def build_route(path, name_a, name_b):
    """Constrói o registro exportável de uma rota direcional."""
    # polilinha com flags por ponto
    ll, tun_f, ln_f, br_f, onc_f = [], [], [], [], []
    node_s = {}
    s_acc = 0.0

    def iln(v):
        try:
            return int(str(v).split(';')[0])
        except (ValueError, TypeError):
            return None

    for w, rev in path:
        g = list(reversed(w['geometry'])) if rev else w['geometry']
        nd = list(reversed(w['nodes'])) if rev else w['nodes']
        tags = w.get('tags', {})
        tun = 1 if tags.get('tunnel') in ('yes', 'building_passage') else 0
        br = 1 if tags.get('bridge') else 0
        # faixas direcionais: vias de mão dupla têm contramão (onc)
        hw = tags.get('highway', '')
        oneway = tags.get('oneway', 'yes' if hw.startswith('motorway') else 'no')
        total = iln(tags.get('lanes'))
        lf, lb = iln(tags.get('lanes:forward')), iln(tags.get('lanes:backward'))
        if oneway in ('yes', '-1'):
            ln = max(2, min(5, total or 3))
            onc = 0
        else:
            fwd_l = lf or (total - lb if total and lb else None) \
                or (max(1, total // 2) if total else 1)
            bck_l = lb or (total - fwd_l if total else fwd_l) or 1
            my, ot = (bck_l, fwd_l) if rev else (fwd_l, bck_l)
            ln = max(1, min(4, my))
            onc = max(1, min(3, ot))
        for i, p in enumerate(g):
            pt = (p['lat'], p['lon'])
            if i > 0:
                a, b = g[i - 1], g[i]
                s_acc += math.hypot((b['lon'] - a['lon']) * KX,
                                    (b['lat'] - a['lat']) * KY)
            node_s.setdefault(nd[i], s_acc)
            if not ll or ll[-1] != pt:
                ll.append(pt)
                tun_f.append(tun)
                ln_f.append(ln)
                br_f.append(br)
                onc_f.append(onc)
            else:
                if tun:
                    tun_f[-1] = 1
                if br:
                    br_f[-1] = 1
    total = s_acc

    proj = [project(la_, lo_, lat0, lon0) for la_, lo_ in ll]

    # poda dobras (>95°) perto das pontas — retornos artificiais do Dijkstra
    # para alcançar o nó-alvo na pista contrária criam grampos indirigíveis
    def kinks():
        out = []
        cumv = [0.0]
        for i in range(1, len(proj)):
            cumv.append(cumv[-1] + math.hypot(proj[i][0] - proj[i - 1][0],
                                              proj[i][1] - proj[i - 1][1]))
        for i in range(1, len(proj) - 1):
            ax, az = proj[i - 1]; bx, bz = proj[i]; cx, cz = proj[i + 1]
            h0 = math.atan2(bx - ax, bz - az)
            h1 = math.atan2(cx - bx, cz - bz)
            dh = abs((h1 - h0 + math.pi) % (2 * math.pi) - math.pi)
            if math.degrees(dh) > 95:
                out.append((i, cumv[i]))
        return out, cumv

    s_shift = 0.0
    for _ in range(3):
        ks, cumv = kinks()
        if not ks:
            break
        tot = cumv[-1]
        head = [i for i, cs in ks if cs < 1500]
        tail = [i for i, cs in ks if cs > tot - 1500]
        mid = [i for i, cs in ks if 1500 <= cs <= tot - 1500]
        if mid:
            print(f'  aviso {name_a}->{name_b}: dobra(s) no meio em '
                  f'{[round(cumv[i]) for i in mid]}')
        if not head and not tail:
            break
        i0 = (max(head) + 1) if head else 0
        i1 = (min(tail)) if tail else len(proj) - 1
        s_shift += cumv[i0]
        proj = proj[i0:i1 + 1]
        ll = ll[i0:i1 + 1]
        tun_f = tun_f[i0:i1 + 1]
        ln_f = ln_f[i0:i1 + 1]
        br_f = br_f[i0:i1 + 1]
        onc_f = onc_f[i0:i1 + 1]
    # chanfra cantos agudos (>55°) — retornos e esquinas viram curvas dirigíveis
    def chamfer():
        nonlocal proj, ll, tun_f, ln_f, br_f, onc_f
        np_, nll, ntu, nln, nbr, non = [], [], [], [], [], []
        for i in range(len(proj)):
            if 0 < i < len(proj) - 1:
                ax, az = proj[i - 1]; bx, bz = proj[i]; cx, cz = proj[i + 1]
                h0 = math.atan2(bx - ax, bz - az)
                h1 = math.atan2(cx - bx, cz - bz)
                dh = abs((h1 - h0 + math.pi) % (2 * math.pi) - math.pi)
                if math.degrees(dh) > 55:
                    l0 = math.hypot(bx - ax, bz - az)
                    l1 = math.hypot(cx - bx, cz - bz)
                    d = min(11.0, l0 / 2.5, l1 / 2.5)
                    if d > 2:
                        pA = (bx - (bx - ax) / l0 * d, bz - (bz - az) / l0 * d)
                        pB = (bx + (cx - bx) / l1 * d, bz + (cz - bz) / l1 * d)
                        # ponto médio puxado ao vértice = curva suave
                        pM = ((pA[0] + pB[0]) / 2 * 0.45 + bx * 0.55,
                              (pA[1] + pB[1]) / 2 * 0.45 + bz * 0.55)
                        for pp in (pA, pM, pB):
                            np_.append(pp); nll.append(ll[i]); ntu.append(tun_f[i])
                            nln.append(ln_f[i]); nbr.append(br_f[i]); non.append(onc_f[i])
                        continue
            np_.append(proj[i]); nll.append(ll[i]); ntu.append(tun_f[i])
            nln.append(ln_f[i]); nbr.append(br_f[i]); non.append(onc_f[i])
        proj, ll, tun_f, ln_f, br_f, onc_f = np_, nll, ntu, nln, nbr, non
    chamfer()
    chamfer()  # segunda passada suaviza o que sobrou

    # rebase do comprimento total e do node_s após a poda
    total = 0.0
    for i in range(1, len(proj)):
        total += math.hypot(proj[i][0] - proj[i - 1][0], proj[i][1] - proj[i - 1][1])
    if s_shift > 0:
        node_s = {nid: s - s_shift for nid, s in node_s.items()
                  if 0 <= s - s_shift <= total}
    kept = simplify(proj, 1.5)
    ki, pts = 0, []
    for x, z in kept:
        while proj[ki] != (x, z):
            ki += 1
        pts.append([round(x, 1), round(z, 1), tun_f[ki], ln_f[ki], br_f[ki], onc_f[ki]])

    cum_proj = [0.0]
    for i in range(1, len(proj)):
        cum_proj.append(cum_proj[-1] + math.hypot(proj[i][0] - proj[i - 1][0],
                                                  proj[i][1] - proj[i - 1][1]))

    def dir_at(s):
        import bisect
        i = max(1, min(len(cum_proj) - 1, bisect.bisect_left(cum_proj, s)))
        ax, az = proj[i - 1]; bx, bz = proj[i]
        L = math.hypot(bx - ax, bz - az) or 1
        return (ax, az, (bx - ax) / L, (bz - az) / L)

    # saídas/entradas da Linha Amarela nesta rota
    exits = []
    for e in rd['elements']:
        if e['type'] != 'way' or 'geometry' not in e:
            continue
        if e.get('tags', {}).get('highway') not in ('motorway_link', 'trunk_link'):
            continue
        tags = e.get('tags', {})
        nm = (tags.get('destination', '') or tags.get('name', '') or '').split(';')[0].strip()
        for kind, node_i, pt_i in (('out', 0, min(2, len(e['geometry']) - 1)),
                                   ('in', -1, max(-3, -len(e['geometry'])))):
            nid = e['nodes'][node_i]
            if nid not in node_s or nid not in la_nodes:
                continue
            s = node_s[nid]
            if s < 200 or s > total - 200:
                continue
            p = e['geometry'][pt_i]
            px, pz = project(p['lat'], p['lon'], lat0, lon0)
            ax, az, dx, dz = dir_at(s)
            lat_sign = (px - ax) * -dz + (pz - az) * dx
            exits.append({'s': round(s), 'k': kind,
                          'side': 1 if lat_sign > 0 else -1, 'n': nm})
            break
    exits.sort(key=lambda x: x['s'])
    dedup = []
    for ex in exits:
        if dedup and ex['k'] == dedup[-1]['k'] and ex['side'] == dedup[-1]['side'] \
                and ex['s'] - dedup[-1]['s'] < 90:
            if ex['n'] and not dedup[-1]['n']:
                dedup[-1]['n'] = ex['n']
            continue
        dedup.append(ex)
    exits = dedup
    num, last_s = 0, -1e9
    for ex in exits:
        if ex['k'] != 'out':
            continue
        if ex['s'] - last_s > 450:
            num += 1
        last_s = ex['s']
        ex['num'] = f'{num:02d}'

    # túneis nomeados (no referencial pós-poda)
    tun_spans = []
    s_acc2 = 0.0
    for w, rev in path:
        glen = seglen(w['geometry'])
        if w.get('tags', {}).get('tunnel') in ('yes', 'building_passage'):
            nm = w.get('tags', {}).get('name', '')
            a2, b2 = s_acc2 - s_shift, s_acc2 + glen - s_shift
            if b2 > 0 and a2 < total:
                a2, b2 = max(0, a2), min(total, b2)
                if tun_spans and a2 - tun_spans[-1][1] < 40:
                    tun_spans[-1][1] = b2
                    if nm and not tun_spans[-1][2]:
                        tun_spans[-1][2] = nm
                else:
                    tun_spans.append([a2, b2, nm])
        s_acc2 += glen

    # pedágio nesta rota?
    toll_s = None
    if toll_xz:
        bd, bs = 1e18, None
        acc = 0.0
        for i in range(1, len(proj)):
            ax, az = proj[i - 1]; bx, bz = proj[i]
            L = math.hypot(bx - ax, bz - az)
            d = math.hypot((ax + bx) / 2 - toll_xz[0], (az + bz) / 2 - toll_xz[1])
            if d < bd:
                bd, bs = d, acc + L / 2
            acc += L
        if bd < 120:
            toll_s = round(bs)

    return {'from': name_a, 'to': name_b, 'pts': pts,
            'exits': exits, 'tunnels': [[round(a), round(b), n] for a, b, n in tun_spans],
            'toll': toll_s}


routes_out = []
# Recreio->Fundão e volta primeiro: o jogo usa ROUTES[0..1] como referência
order = [('Recreio', 'Fundão'), ('Fundão', 'Recreio')]
order += [p for p in PAIRS if p not in order]
for a, b in order:
    if (a, b) in raw_routes:
        r = build_route(raw_routes[(a, b)], a, b)
        routes_out.append(r)
        print(f"  {a} -> {b}: {len(r['pts'])} pts, "
              f"{sum(1 for e in r['exits'] if e['k'] == 'out')} saídas, "
              f"{len(r['tunnels'])} túneis, pedágio={r['toll']}")

# ---------- 4. Vias do entorno ----------
TYPES = {'motorway': 'mw', 'motorway_link': 'lk', 'trunk': 'tr',
         'trunk_link': 'lk', 'primary': 'pr', 'primary_link': 'lk',
         'secondary': 'pr', 'secondary_link': 'lk', 'tertiary': 'pr'}
roads = []
for e in rd['elements']:
    if e['type'] != 'way' or 'geometry' not in e:
        continue
    tags = e.get('tags', {})
    t = TYPES.get(tags.get('highway'))
    if not t:
        continue
    if tags.get('tunnel') in ('yes', 'building_passage'):
        continue
    if tags.get('name') == 'Linha Amarela':
        t = 'la'
    pts = [project(p['lat'], p['lon'], lat0, lon0) for p in e['geometry']]
    pts = simplify(pts, 4.0)
    if len(pts) >= 2:
        r = {'t': t, 'p': [[round(x, 1), round(z, 1)] for x, z in pts]}
        if tags.get('bridge'):
            r['b'] = 1  # viaduto/elevado
        roads.append(r)
print(f'{len(roads)} vias do entorno')

# ---------- 5. Bairros próximos a qualquer rota ----------
all_route_pts = []
for r in routes_out:
    all_route_pts.extend((p[0], p[1]) for p in r['pts'][::4])
places = []
seen_names = set()
for fn in ('places_raw.json', 'places_oeste.json', 'places_costaverde.json'):
    try:
        pl = load(fn)
    except FileNotFoundError:
        continue
    for e in pl['elements']:
        nm = e.get('tags', {}).get('name')
        if not nm or nm in seen_names:
            continue
        x, z = project(e['lat'], e['lon'], lat0, lon0)
        dmin = min(math.hypot(px - x, pz - z) for px, pz in all_route_pts[::3])
        if dmin < 2400:
            places.append({'n': nm, 'p': [round(x), round(z)],
                           't': e['tags'].get('place', 'suburb')})
            seen_names.add(nm)
print(f'{len(places)} bairros próximos às rotas')

FAMOUS = {'Avenida Brasil', 'Linha Vermelha', 'Avenida das Américas',
          'Avenida Ayrton Senna', 'Autoestrada Grajaú-Jacarepaguá',
          'Avenida Lúcio Costa'}
labels = {}
for e in rd['elements']:
    if e['type'] != 'way':
        continue
    name = e.get('tags', {}).get('name', '')
    if name in FAMOUS and name not in labels and 'geometry' in e:
        g = e['geometry'][len(e['geometry']) // 2]
        labels[name] = project(g['lat'], g['lon'], lat0, lon0)

# ---------- 6. Pontos intermediários nomeados ----------
NAMED = {
    'Praia da Barra': (-23.0105, -43.3655),
    'Cebolão (início da L.A.)': (-22.9519, -43.3569),
}
points = []
for k, (la_, lo_) in NAMED.items():
    x, z = project(la_, lo_, lat0, lon0)
    points.append({'n': k, 'p': [round(x, 1), round(z, 1)]})

# maciços reais (aprox.) projetados no centro atual
HILLS = [
    (-22.943, -43.285, 1500, 650),   # Maciço da Tijuca
    (-22.935, -43.443, 2400, 900),   # Pedra Branca
    (-22.860, -43.270, 750, 240),    # Serra da Misericórdia
    (-22.920, -43.260, 800, 300),    # Grajaú
    (-22.965, -43.560, 1400, 550),   # Serra de Guaratiba
    (-22.940, -43.770, 1900, 700),   # Serra do Mar (Costa Verde)
    (-22.890, -43.900, 1700, 750),   # Serra do Mar (Mangaratiba)
]
hills = []
for la_, lo_, r, h in HILLS:
    x, z = project(la_, lo_, lat0, lon0)
    hills.append({'p': [round(x), round(z)], 'r': r, 'h': h})
if toll_xz:
    points.append({'n': 'Pedágio', 'p': [round(toll_xz[0], 1), round(toll_xz[1], 1)]})

out = {
    'center': [lat0, lon0],
    'routes': routes_out,
    'roads': roads,
    'labels': [{'n': k, 'p': [round(v[0]), round(v[1])]} for k, v in labels.items()],
    'places': places,
    'points': points,
    'hills': hills,
}
with open('map_data.js', 'w', encoding='utf-8') as f:
    f.write('const MAP_DATA = ')
    json.dump(out, f, separators=(',', ':'))
    f.write(';\n')

import os
print(f"map_data.js: {os.path.getsize('map_data.js')/1024:.0f} KB")
