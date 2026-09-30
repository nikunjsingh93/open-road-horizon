"""
Procedural luxury SUV (modelled on the proportions of a current full-size luxury SUV) for Open Road.
Run:  blender --background --python create_suv.py -- [--preview out_dir] [--views a,b] [--glb path]
Same conventions as create_car.py (Blender Z-up, front = +Y -> glTF -Z, origin on the ground between the axles) and it re-uses its helpers.

Construction: one closed body loft (hood -> windscreen -> roof -> tailgate) -> subdivision -> solidify into a real 3 cm sheet-metal shell
-> windows / arches cut with exact booleans (clean reveals, the inner face of the shell is the door card / headliner) -> glass panes
are separate surfaces sitting just behind the holes -> decals and small parts.
"""
import sys, os, math
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy, bmesh
from mathutils import Vector, Matrix
from math import sin, cos, pi
import create_car as C

mi = C.mi
interp = C.interp

# ----------------------------------------------------------------------------------------------
# Parameters (metres)
# ----------------------------------------------------------------------------------------------
WHEELBASE = 3.00
TRACK = 1.70
TIRE_R = 0.40
HUB_Z = 0.40
FRONT_Y = WHEELBASE / 2
REAR_Y = -WHEELBASE / 2
ARCH_R = 0.455
THICK = 0.03                        # sheet-metal shell thickness
for k, v in dict(WHEELBASE=WHEELBASE, TRACK=TRACK, TIRE_R=TIRE_R, HUB_Z=HUB_Z, FRONT_Y=FRONT_Y, REAR_Y=REAR_Y, ARCH_R=ARCH_R, SPOKES=16, SPOKE_W=0.42).items():
    setattr(C, k, v)

YN, YP = -2.67, 2.38                # tail / nose (short front overhang, long rear overhang)

# side profile tables: (y, value), y ascending ------------------------------------------------
W_ = [(-2.67, 0.76), (-2.655, 0.80), (-2.63, 0.85), (-2.56, 0.91), (-2.4, 0.96), (-2.2, 0.985), (-1.9, 0.995), (-1.0, 1.0), (0.5, 1.0), (1.2, 0.995), (1.8, 0.985), (2.1, 0.965), (2.28, 0.93), (2.35, 0.89), (2.38, 0.80)]
ZB_ = [(-2.67, 0.47), (-2.60, 0.42), (-2.4, 0.35), (-2.1, 0.31), (-1.6, 0.29), (-1.0, 0.285), (0, 0.28), (1.0, 0.285), (1.6, 0.295), (2.0, 0.32), (2.25, 0.37), (2.36, 0.42), (2.38, 0.46)]
ZS_ = [(-2.67, 1.0), (-2.62, 1.12), (-2.55, 1.30), (-2.3, 1.33), (-1.5, 1.325), (-0.6, 1.315), (0.3, 1.30), (0.8, 1.28), (1.05, 1.25), (1.4, 1.21), (2.0, 1.15), (2.3, 1.10), (2.38, 1.0)]
R_ = [(-2.67, 1.0), (-2.65, 1.10), (-2.62, 1.22), (-2.55, 1.38), (-2.45, 1.56), (-2.34, 1.72), (-2.22, 1.815), (-2.10, 1.845), (-2.0, 1.856), (-1.0, 1.866), (-0.3, 1.868), (-0.05, 1.85), (0.15, 1.78), (0.4, 1.65), (0.65, 1.50), (0.85, 1.37), (0.95, 1.315), (1.05, 1.285), (1.3, 1.255), (1.75, 1.205), (2.1, 1.17), (2.3, 1.14), (2.36, 1.09), (2.38, 1.02)]
GB_ = [(-2.67, 0.80), (-2.55, 0.88), (-2.3, 0.935), (-1.5, 0.955), (-0.5, 0.96), (0.3, 0.95), (0.7, 0.93), (0.93, 0.90)]     # greenhouse half width at the belt
GR_ = [(-2.67, 0.50), (-2.55, 0.58), (-2.35, 0.70), (-2.1, 0.77), (-1.0, 0.80), (0.0, 0.78), (0.3, 0.75), (0.6, 0.72), (0.93, 0.71)]   # roof edge half width

RING_YS = [-2.67, -2.655, -2.63, -2.60, -2.56, -2.52, -2.46, -2.40, -2.33, -2.24, -2.10, -1.90, -1.65, -1.40, -1.15, -0.90, -0.65, -0.42, -0.22, -0.05, 0.10, 0.19, 0.28, 0.37, 0.46, 0.55, 0.64, 0.72, 0.80, 0.86, 0.92, 1.00, 1.08, 1.20, 1.36, 1.55, 1.75, 1.95, 2.12, 2.24, 2.32, 2.36, 2.38]


def smooth01(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def half_profile(y):
    w = interp(W_, y); zb = interp(ZB_, y); zs = interp(ZS_, y); R = interp(R_, y)
    gb = interp(GB_, y); gr = interp(GR_, y)
    zs = min(zs, R - 0.035)
    b = smooth01(1.03, 0.86, y)                     # 0 = hood, 1 = greenhouse
    dz = R - zs
    hood = [(0.94 * w, R - 0.014), (0.80 * w, R - 0.003), (0.62 * w, R), (0.32 * w, R), (0.0, R)]
    glass = [(gb, zs + 0.035 + 0.02 * dz / 0.6), (gb - (gb - gr) * 0.48, zs + 0.47 * dz), (gr, R - 0.055), (gr * 0.52, R - 0.012), (0.0, R)]
    up = [(hood[i][0] + (glass[i][0] - hood[i][0]) * b, hood[i][1] + (glass[i][1] - hood[i][1]) * b) for i in range(5)]
    return [
        (0.0, zb),
        (0.70 * w, zb),
        (0.935 * w, zb + 0.035),        # 2 rocker corner
        (1.0 * w, zb + 0.17),           # 3
        (1.0 * w, zs - 0.20),           # 4
        (0.992 * w, zs - 0.045),        # 5
        (0.966 * w, zs),                # 6 shoulder / belt crease
    ] + up                              # 7..11


CREASES = {2: 0.6, 6: 0.7}
N_RING = 20
# strips (between neighbouring ring columns) that are gloss black: sill cladding, and the blacked-out window surround / pillars
BLACK_SILL = {1, 17}
BLACK_PILLAR = {5, 6, 7, 11, 12, 13}
BLACK_PILLAR_TOP = {8, 10}          # only around the windscreen (A pillars)


def body_ring(y):
    h = half_profile(y)
    # no centre-line vertices: bottom and top are single straight edges, so the end caps are plain triangulated polygons
    left = [Vector((-x, y, z)) for x, z in h[1:-1]]
    right = [Vector((x, y, z)) for x, z in reversed(h[1:-1])]
    return left + right


def strip_material(i_ring, ys, j):
    yc = (ys[i_ring] + ys[i_ring + 1]) * 0.5
    if j in BLACK_SILL and -1.12 < yc < 1.12: return mi('BlackPlastic')
    if j in BLACK_PILLAR and -2.06 < yc < 0.93: return mi('BlackPlastic')
    if j in BLACK_PILLAR_TOP and 0.10 < yc < 0.90: return mi('BlackPlastic')
    return mi('CarPaint')


def loft_grid(name, rings, ys, crease_cols, crease_ends):
    """Closed ring loft; the end caps are triangulated (an n-gon cap shatters under subdivision, degenerate quads give NaN normals)."""
    bm = bmesh.new()
    cl = bm.edges.layers.float.get('crease_edge') or bm.edges.layers.float.new('crease_edge')
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for j in range(n):
            f = bm.faces.new((vs[i][j], vs[i][(j + 1) % n], vs[i + 1][(j + 1) % n], vs[i + 1][j]))
            f.material_index = strip_material(i, ys, j)
    bm.edges.ensure_lookup_table()
    for ri in (0, len(rings) - 1):
        cap = bm.faces.new(vs[ri])
        bmesh.ops.triangulate(bm, faces=[cap], quad_method='BEAUTY', ngon_method='BEAUTY')
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    cen = Vector((0, 0, 1.0))
    for f in bm.faces:                               # the solid is convex enough: every face must point away from its middle
        if f.normal.dot(f.calc_center_median() - cen) < 0: f.normal_flip()
    bm.edges.ensure_lookup_table()
    for j, cv in crease_cols.items():
        for i in range(len(rings) - 1):
            e = bm.edges.get((vs[i][j], vs[i + 1][j]))
            if e: e[cl] = cv
    for ri in (0, len(rings) - 1):
        for j in range(n):
            e = bm.edges.get((vs[ri][j], vs[ri][(j + 1) % n]))
            if e: e[cl] = crease_ends
    idx = [f.material_index for f in bm.faces]
    obj = C.new_obj_from_bm(name, bm)            # (assigning the material slots resets the face indices, so put them back)
    for p, m in zip(obj.data.polygons, idx): p.material_index = m
    return obj


def mark_sharp(obj, ang=34):
    """hard edges (panel corners) stay crisp in the glTF: edges sharper than ang degrees are flagged sharp"""
    bm = C.mesh_bm(obj)
    lim = math.radians(ang)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim: e.smooth = False
    bm.to_mesh(obj.data); bm.free()


def build_body():
    rings = [body_ring(y) for y in RING_YS]
    n = len(rings[0])
    cols = {}
    for j, v in CREASES.items():
        cols[j - 1] = v; cols[n - j] = v
    body = loft_grid('Body', rings, RING_YS, cols, 1.0)
    C.subsurf_apply(body, 2)
    C.smooth_shade(body)
    mark_sharp(body)
    for p in body.data.polygons:                  # the two end panels are flat: flat shading (smoothing them gives streaky normals)
        if all(abs(body.data.vertices[i].co.y - YP) < 0.0005 or abs(body.data.vertices[i].co.y - YN) < 0.0005 for i in p.vertices): p.use_smooth = False
    return body


# ----------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------
def prism(name, poly, plane, lo, hi, mat='BlackPlastic'):
    """Closed extruded polygon. plane 'YZ' -> poly in (y, z) extruded along x in [lo, hi]; 'XY' -> (x, y) along z; 'XZ' -> (x, z) along y."""
    bm = bmesh.new()
    def P(a, b, c):
        return {'YZ': (c, a, b), 'XY': (a, b, c), 'XZ': (a, c, b)}[plane]
    bot = [bm.verts.new(P(a, b, lo)) for a, b in poly]
    top = [bm.verts.new(P(a, b, hi)) for a, b in poly]
    n = len(poly)
    bm.faces.new(bot); bm.faces.new(list(reversed(top)))
    for i in range(n):
        bm.faces.new((bot[i], bot[(i + 1) % n], top[(i + 1) % n], top[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return C.make_obj(name, bm, mat_idx=mi(mat))


def join_objs(objs, name):
    C.activate(objs[0])
    for o in objs[1:]: o.select_set(True)
    if len(objs) > 1: bpy.ops.object.join()
    o = bpy.context.active_object; o.name = name
    return o


def boolean_cut(obj, cutter, use_self=True):
    C.activate(obj)
    m = obj.modifiers.new('cut', 'BOOLEAN')
    m.operation = 'DIFFERENCE'; m.object = cutter; m.solver = 'EXACT'
    try: m.use_self = use_self
    except Exception: pass
    try: m.material_mode = 'INDEX'
    except Exception: pass
    bpy.ops.object.modifier_apply(modifier=m.name)


def solidify(obj, thick):
    C.activate(obj)
    m = obj.modifiers.new('sol', 'SOLIDIFY')
    m.thickness = thick; m.offset = -1.0; m.use_even_offset = True; m.use_rim = True
    m.material_offset = mi('Interior')          # inner skin = door cards / headliner
    m.material_offset_rim = 0
    bpy.ops.object.modifier_apply(modifier=m.name)


# ---- windows ---------------------------------------------------------------------------------
SIDE_FRONT = [(0.64, 1.365), (0.12, 1.735), (-0.36, 1.74), (-0.385, 1.365)]
SIDE_REARDOOR = [(-0.51, 1.365), (-0.495, 1.74), (-1.38, 1.74), (-1.42, 1.365)]
SIDE_QUARTER = [(-1.50, 1.365), (-1.49, 1.74), (-1.90, 1.74), (-2.00, 1.69), (-2.06, 1.60), (-2.08, 1.46), (-2.08, 1.375)]
SIDE_POLYS = [SIDE_FRONT, SIDE_REARDOOR, SIDE_QUARTER]
SCREEN = [(-0.74, 0.93), (0.74, 0.93), (0.63, 0.12), (-0.63, 0.12)]      # plan view (x, y)
TAILGLASS = [(-0.70, 1.30), (0.70, 1.30), (0.64, 1.70), (-0.64, 1.70)]      # (x, z) looking along y


def expand(poly, d):
    cx = sum(p[0] for p in poly) / len(poly); cy = sum(p[1] for p in poly) / len(poly)
    out = []
    for a, b in poly:
        v = Vector((a - cx, b - cy)); L = v.length
        v = v * ((L + d) / L) if L > 1e-6 else v
        out.append((cx + v.x, cy + v.y))
    return out


def cutters():
    objs = []
    for sx in (-1, 1):
        lo, hi = (0.60, 1.30) if sx > 0 else (-1.30, -0.60)
        for k, poly in enumerate(SIDE_POLYS):
            objs.append(prism('cS%d' % k, poly, 'YZ', lo, hi))
    objs.append(prism('cWS', SCREEN, 'XY', 1.0, 2.2))
    objs.append(prism('cTG', TAILGLASS, 'XZ', -3.0, -2.2))
    return join_objs(objs, 'Cutters')


def arch_cutters():
    objs = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (-1, 1):
            bpy.ops.mesh.primitive_cylinder_add(vertices=160, radius=ARCH_R, depth=0.66, location=(sx * 0.95, sy, HUB_Z), rotation=(0, math.radians(90), 0))
            c = bpy.context.active_object
            C.set_all_mats(c.data)
            for p in c.data.polygons: p.material_index = mi('BlackPlastic')
            objs.append(c)
    return join_objs(objs, 'ArchCutters')


def glass_panes(shell):
    """Window glass: the faces of the (un-cut) outer surface that lie under each window, pushed 14 mm behind the surface."""
    d = shell.copy(); d.data = shell.data.copy(); d.name = 'GlassPanes'; C.link(d)
    bm = bmesh.new(); bm.from_mesh(d.data); bm.faces.ensure_lookup_table()
    keep = []
    sides = [expand(p, 0.03) for p in SIDE_POLYS]
    ps, pt = expand(SCREEN, 0.03), expand(TAILGLASS, 0.03)
    for f in bm.faces:
        c = f.calc_center_median(); n = f.normal
        ok = False
        if abs(n.x) > 0.2 and abs(c.x) > 0.5 and n.x * c.x > 0 and c.z > 1.28:
            ok = any(C.point_in_poly(c.y, c.z, p) for p in sides)
        if not ok and n.z > 0.2 and c.z > 1.12 and -0.05 < c.y < 0.98:
            ok = C.point_in_poly(c.x, c.y, ps)
        if not ok and n.y < -0.3 and c.y < -2.2:
            ok = C.point_in_poly(c.x, c.z, pt)
        if ok: keep.append(f)
    kset = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in kset], context='FACES')
    bm.verts.ensure_lookup_table()
    bm.normal_update()
    for v in bm.verts: v.co -= v.normal * 0.014
    for f in bm.faces: f.material_index = mi('Glass'); f.smooth = True
    bm.to_mesh(d.data); bm.free()
    return d


def classify(body):
    """Underbody, and the inner skin: door cards below the belt, headliner above it."""
    bm = C.mesh_bm(body); bm.faces.ensure_lookup_table()
    for f in bm.faces:
        if f.material_index != 0: continue
        if f.normal.z < -0.6: f.material_index = mi('Underbody')
    for f in bm.faces:
        if f.material_index == mi('Seat') or (f.material_index == mi('Interior') and False): f.material_index = mi('Interior')
        if f.material_index == mi('Interior') and f.calc_center_median().z > 1.33: f.material_index = mi('Headliner')
    bm.to_mesh(body.data); bm.free()


def wheel_wells():
    """Liners behind the arch openings: an arc (upper part only, nothing may hang below the sill) closed at the inner end.
    Built for the right side and mirrored for the left."""
    out = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (1, -1):
            bm = bmesh.new()
            R = ARCH_R + 0.028
            a0, a1 = math.radians(8), math.radians(172)
            segs = 56
            angs = [a0 + (a1 - a0) * i / segs for i in range(segs + 1)]
            rings = [[bm.verts.new((x, sy + R * cos(a), HUB_Z + R * sin(a))) for a in angs] for x in (0.66, 0.965)]
            for i in range(segs):
                bm.faces.new((rings[0][i], rings[0][i + 1], rings[1][i + 1], rings[1][i]))
            bm.faces.new(rings[0])
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            if sx < 0:
                for v in bm.verts: v.co.x = -v.co.x
                bmesh.ops.reverse_faces(bm, faces=bm.faces)
            out.append(C.make_obj('WheelWell', bm, mat_idx=mi('WheelWell')))
    return out


# ---- decals ----------------------------------------------------------------------------------
_orig_curve_line = C.curve_line


def face_out(obj, centre=Vector((0, 0, 1.0))):
    """make every face of a projected decal point away from the car (single-sided materials otherwise vanish)"""
    bm = C.mesh_bm(obj)
    for f in bm.faces:
        if f.normal.dot(f.calc_center_median() - centre) < 0: f.normal_flip()
    bm.to_mesh(obj.data); bm.free()
    for p in obj.data.polygons: p.use_smooth = True


def decal2(name, poly, plane, fixed, shell, mat, offset=0.0025, res=0.04, axis=None, thickness=0.0):
    """Like create_car.decal but the outline is the exact polygon (triangulated and subdivided, not a stair-stepped grid) - far fewer faces."""
    bm = bmesh.new()
    P = lambda a, b: (a, fixed, b) if plane == 'XZ' else ((fixed, a, b) if plane == 'YZ' else (a, b, fixed))
    f = bm.faces.new([bm.verts.new(P(a, b)) for a, b in poly])
    bmesh.ops.triangulate(bm, faces=[f])
    for _ in range(9):
        long_edges = [e for e in bm.edges if e.calc_length() > res]
        if not long_edges: break
        bmesh.ops.subdivide_edges(bm, edges=long_edges, cuts=1, use_grid_fill=True)
    obj = C.make_obj(name, bm, mat_idx=mi(mat))
    sw = obj.modifiers.new('sw', 'SHRINKWRAP')
    sw.wrap_method = 'PROJECT'; sw.target = shell
    ax = axis or {'XZ': 'y', 'YZ': 'x', 'XY': 'z'}[plane]
    sw.use_project_x = ax == 'x'; sw.use_project_y = ax == 'y'; sw.use_project_z = ax == 'z'
    sw.use_negative_direction = True; sw.use_positive_direction = True
    sw.cull_face = 'OFF'; sw.offset = offset
    C.activate(obj); bpy.ops.object.modifier_apply(modifier=sw.name)
    face_out(obj)
    return obj


def curve_line2(*a, **k):
    o = _orig_curve_line(*a, **k)
    face_out(o)
    return o


C.decal = decal2
C.curve_line = curve_line2


def ellipse(cx, cz, rx, rz, n=20):
    return [(cx + rx * cos(2 * pi * i / n), cz + rz * sin(2 * pi * i / n)) for i in range(n)]


def details(shell):
    D = lambda *a, **k: C.decal(*a, **k)
    L = lambda *a, **k: C.curve_line(*a, **k)
    fy, ty = 2.7, -2.95
    # ---------------- front: hood lip, slim headlights over a wide grille, big lower intake, silver skid ----------------
    D('GrilleBg', [(-0.44, 1.000), (0.44, 1.000), (0.44, 0.770), (-0.44, 0.770)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0028)
    D('GrilleFrame', [(-0.455, 1.008), (0.455, 1.008), (0.455, 0.758), (-0.455, 0.758)], 'XZ', fy, shell, 'Chrome', offset=0.0016)
    D('GrilleIn', [(-0.44, 0.998), (0.44, 0.998), (0.44, 0.770), (-0.44, 0.770)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0036)
    for k in range(5):
        z0 = 0.80 + k * 0.042
        D('Slat', [(-0.425, z0 + 0.010), (0.425, z0 + 0.010), (0.425, z0), (-0.425, z0)], 'XZ', fy, shell, 'Chrome', offset=0.0048)
    for sx in (-1, 1):
        D('HeadBg', [(sx * 0.46, 0.998), (sx * 0.845, 0.998), (sx * 0.85, 0.922), (sx * 0.46, 0.922)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0032)
        D('HeadLens', [(sx * 0.475, 0.990), (sx * 0.835, 0.990), (sx * 0.84, 0.931), (sx * 0.475, 0.931)], 'XZ', fy, shell, 'HeadLens', offset=0.0046)
        D('HeadInner', [(sx * 0.49, 0.982), (sx * 0.825, 0.982), (sx * 0.83, 0.94), (sx * 0.49, 0.94)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0051)
        D('DRL', [(sx * 0.49, 0.988), (sx * 0.838, 0.988), (sx * 0.838, 0.974), (sx * 0.49, 0.974)], 'XZ', fy, shell, 'HeadLamp', offset=0.0058)
        D('DRL2', [(sx * 0.56, 0.952), (sx * 0.81, 0.952), (sx * 0.81, 0.945), (sx * 0.56, 0.945)], 'XZ', fy, shell, 'HeadLamp', offset=0.0058)
        for k in range(5):
            D('Matrix', ellipse(sx * (0.60 + 0.045 * k), 0.963, 0.013, 0.0095, 10), 'XZ', fy, shell, 'HeadLamp', offset=0.0058)
        D('LowLamp', [(sx * 0.66, 0.605), (sx * 0.74, 0.605), (sx * 0.74, 0.585), (sx * 0.66, 0.585)], 'XZ', fy, shell, 'HeadLamp', offset=0.0055)
    D('PlateF', [(-0.26, 0.745), (0.26, 0.745), (0.26, 0.635), (-0.26, 0.635)], 'XZ', fy, shell, 'Plate', offset=0.0035)
    D('LowerIntake', [(-0.80, 0.69), (0.80, 0.69), (0.80, 0.545), (-0.80, 0.545)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0022)
    for z0 in (0.655, 0.59):
        D('IntakeBar', [(-0.74, z0 + 0.012), (0.74, z0 + 0.012), (0.74, z0), (-0.74, z0)], 'XZ', fy, shell, 'Chrome', offset=0.0044)
    D('Skid', [(-0.74, 0.535), (0.74, 0.535), (0.66, 0.475), (-0.66, 0.475)], 'XZ', fy, shell, 'RimAlloy', offset=0.0035)
    D('ValanceF', [(-0.80, 0.475), (0.80, 0.475), (0.80, 0.40), (-0.80, 0.40)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0018)
    # hood shut lines
    for sx in (-1, 1):
        L('HoodLine', [(sx * 0.80, 1.00, 1.6), (sx * 0.86, 1.6, 1.6), (sx * 0.84, 2.1, 1.6), (sx * 0.66, 2.33, 1.6)], shell, mat='Trim', width=0.004, offset=0.0012, axis='z')
    L('HoodFront', [(-0.66, 2.33, 1.6), (0.0, 2.36, 1.6), (0.66, 2.33, 1.6)], shell, mat='Trim', width=0.004, offset=0.0012, axis='z')
    D('Cowl', [(-0.80, 1.02), (0.80, 1.02), (0.80, 0.955), (-0.80, 0.955)], 'XY', 1.6, shell, 'BlackPlastic', offset=0.002)
    # ---------------- rear: body-coloured tailgate, black band, vertical lamps, black bumper ----------------
    D('TailBand', [(-0.70, 1.285), (0.70, 1.285), (0.70, 1.225), (-0.70, 1.225)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0028)
    D('RearPlateBg', [(-0.30, 0.955), (0.30, 0.955), (0.30, 0.795), (-0.30, 0.795)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0028)
    D('Plate', [(-0.26, 0.945), (0.26, 0.945), (0.26, 0.808), (-0.26, 0.808)], 'XZ', ty, shell, 'Plate', offset=0.0045)
    D('RearBumper', [(-0.78, 0.74), (0.78, 0.74), (0.78, 0.50), (-0.78, 0.50)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0018)
    D('RearStrip', [(-0.72, 0.725), (0.72, 0.725), (0.72, 0.695), (-0.72, 0.695)], 'XZ', ty, shell, 'RimAlloy', offset=0.0032)
    for sx in (-1, 1):
        D('TailBg', [(sx * 0.66, 1.50), (sx * 0.80, 1.50), (sx * 0.83, 0.93), (sx * 0.66, 0.93)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0028)
        D('TailVert', [(sx * 0.70, 1.47), (sx * 0.77, 1.47), (sx * 0.80, 0.95), (sx * 0.70, 0.95)], 'XZ', ty, shell, 'TailLamp', offset=0.0042)
        D('RearRefl', [(sx * 0.66, 0.66), (sx * 0.77, 0.66), (sx * 0.77, 0.62), (sx * 0.66, 0.62)], 'XZ', ty, shell, 'TailLamp', offset=0.0045)
        D('RevLight', [(sx * 0.56, 0.66), (sx * 0.66, 0.66), (sx * 0.66, 0.62), (sx * 0.56, 0.62)], 'XZ', ty, shell, 'HeadLens', offset=0.0045)
    # ---------------- sides ----------------
    for sx in (-1, 1):
        X = sx * 1.4
        D('SillChrome', [(-1.02, 0.435), (1.02, 0.435), (1.02, 0.425), (-1.02, 0.425)], 'YZ', X, shell, 'RimAlloy', offset=0.0032)
        for ay in (FRONT_Y, REAR_Y):
            pts = [(X, ay + (ARCH_R + 0.03) * cos(a), HUB_Z + (ARCH_R + 0.03) * sin(a)) for a in [pi * i / 40 for i in range(0, 41)]]
            L('ArchTrim', pts, shell, mat='BlackPlastic', width=0.03, offset=0.0028, axis='x')
        # door cuts (front door front edge runs behind the gill, doors split at the B pillar)
        L('DoorF', [(X, 1.04, 0.44), (X, 1.06, 0.80), (X, 1.02, 1.12), (X, 0.90, 1.29)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        L('DoorM', [(X, -0.40, 0.44), (X, -0.40, 0.90), (X, -0.41, 1.32)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        L('DoorR', [(X, -1.43, 1.34), (X, -1.43, 1.05), (X, -1.30, 0.88)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        L('DoorLow', [(X, 1.04, 0.47), (X, -1.02, 0.47)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        # flush handles
        D('HandleF', [(-0.02, 1.17), (-0.30, 1.17), (-0.30, 1.145), (-0.02, 1.145)], 'YZ', X, shell, 'Trim', offset=0.004)
        D('HandleR', [(-0.76, 1.17), (-1.04, 1.17), (-1.04, 1.145), (-0.76, 1.145)], 'YZ', X, shell, 'Trim', offset=0.004)
        # the tall vertical fender trim in front of the front door
        D('GillDark', [(0.86, 1.22), (1.02, 1.22), (1.02, 0.60), (0.86, 0.60)], 'YZ', X, shell, 'BlackPlastic', offset=0.003)
        D('GillBar', [(0.925, 1.17), (0.96, 1.17), (0.96, 0.655), (0.925, 0.655)], 'YZ', X, shell, 'RimAlloy', offset=0.0042)
        # fuel flap on the right rear quarter
        if sx > 0:
            D('FuelFlap', ellipse(-1.85, 1.08, 0.09, 0.075), 'YZ', X, shell, 'Trim', offset=0.003)
        D('Repeater', [(2.10, 0.95), (2.20, 0.95), (2.20, 0.925), (2.10, 0.925)], 'YZ', X, shell, 'Amber', offset=0.004)



def tube_along(name, pts, nrm, a, b, mat='BlackPlastic', seg=12):
    """Rounded strip (ellipse a wide x b thick) following pts; nrm = surface normals (the thin side points along them)."""
    bm = bmesh.new()
    rings = []
    for i, p in enumerate(pts):
        tng = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        n = nrm[i]
        w = tng.cross(n).normalized()
        nn = w.cross(tng).normalized()
        k = min(1.0, 0.45 + i / 3.0) * min(1.0, 0.55 + (len(pts) - 1 - i) / 6.0)       # rounded ends
        rings.append([bm.verts.new(p + w * (a * k * cos(2 * pi * s / seg)) + nn * (b * k * sin(2 * pi * s / seg))) for s in range(seg)])
    for i in range(len(rings) - 1):
        for s in range(seg):
            bm.faces.new((rings[i][s], rings[i][(s + 1) % seg], rings[i + 1][(s + 1) % seg], rings[i + 1][s]))
    for cap in (rings[0], list(reversed(rings[-1]))):
        bm.faces.new(cap)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    o = C.make_obj(name, bm, mat_idx=mi(mat))
    for p in o.data.polygons: p.use_smooth = True
    return o


def pillar_trims(shell):
    """The cut edges of the A pillars are faceted where the straight cutters cross the curved roof edge. Smooth black beading along both edges
    covers that. Both beads taper to a point and sink into the roof, so the pillar ends cleanly at the top (no stump, no second pole)."""
    out = []
    def smooth(pts, nrm):
        for _ in range(4):
            pts = [pts[0]] + [(pts[i - 1] + 2 * pts[i] + pts[i + 1]) * 0.25 for i in range(1, len(pts) - 1)] + [pts[-1]]
            nrm = [nrm[0]] + [((nrm[i - 1] + 2 * nrm[i] + nrm[i + 1]) * 0.25).normalized() for i in range(1, len(nrm) - 1)] + [nrm[-1]]
        return pts, nrm
    def finish(name, pts, nrm, a, b):
        body = [p - nn * 0.012 for p, nn in zip(pts, nrm)]
        for k in range(1, 5):                              # sink the last rings into the shell
            body[-k] = body[-k] - nrm[-k] * (0.014 * (5 - k))
        out.append(tube_along(name, body, nrm, a, b))
    for sx in (-1, 1):
        # A) along the front door glass' front edge (a line in the side view), shifted a little into the pillar
        pts, nrm = [], []
        for i in range(16):
            u = i / 15
            y = 0.70 - 0.62 * u
            z = 1.365 + 0.41 * u
            hit, loc, nor, idx = shell.ray_cast(Vector((sx * 2.0, y, z)), Vector((-sx, 0, 0)))
            if hit: pts.append(loc); nrm.append(nor.copy())
        if len(pts) > 6:
            pts, nrm = smooth(pts, nrm)
            finish('PillarBeadA', pts, nrm, 0.05, 0.035)
        # B) along the windscreen's side edge (a line in plan view), shifted into the pillar
        pts, nrm = [], []
        for i in range(16):
            u = i / 15
            y = 0.93 - 0.87 * u
            x = 0.77 - 0.11 * u
            hit, loc, nor, idx = shell.ray_cast(Vector((sx * x, y, 3.0)), Vector((0, 0, -1)))
            if hit: pts.append(loc); nrm.append(nor.copy())
        if len(pts) > 6:
            pts, nrm = smooth(pts, nrm)
            finish('PillarBeadB', pts, nrm, 0.05, 0.035)
    return out


def mirrors():
    out = []
    for sx in (-1, 1):
        yaw = sx * math.radians(-8)
        centre = Vector((sx * 1.085, 0.55, 1.385))
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.29; v.co.y *= 0.20; v.co.z *= 0.17
        m = C.make_obj('MirrorHousing', bm, mat_idx=mi('BlackPlastic'))
        m.location = centre; m.rotation_euler = (0, 0, yaw)
        for p in m.data.polygons: p.use_smooth = True
        out.append(m)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=16, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.245; v.co.y *= 0.03; v.co.z *= 0.13
        g = C.make_obj('MirrorGlass', bm, mat_idx=mi('MirrorGlass'))
        off = Vector((0, -0.094, 0)); off.rotate(Matrix.Rotation(yaw, 3, 'Z'))
        g.location = centre + off; g.rotation_euler = (0, 0, yaw)
        for p in g.data.polygons: p.use_smooth = True
        out.append(g)
        bm = bmesh.new()
        C.box_bm(bm, (0, 0, 0), (0.14, 0.06, 0.05))
        s = C.make_obj('MirrorStalk', bm, mat_idx=mi('BlackPlastic'))
        s.location = (sx * 0.98, 0.56, 1.34)
        out.append(s)
    return out


def roof_parts():
    out = []
    # shark-fin antenna
    bm = bmesh.new()
    C.box_bm(bm, (0, 0, 0), (0.08, 0.26, 0.05), taper=(0.6, 0.5))
    f = C.make_obj('Antenna', bm, mat_idx=mi('BlackPlastic'))
    f.location = (0, -1.45, 1.885)
    out.append(f)
    # exhaust tips
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=0.05, radius2=0.05, depth=0.17)
        for v in bm.verts: v.co.x *= 1.5
        e = C.make_obj('ExhaustTip', bm, mat_idx=mi('Chrome'))
        e.rotation_euler = (math.radians(90), 0, 0); e.location = (sx * 0.52, -2.64, 0.40)
        for p in e.data.polygons: p.use_smooth = True
        out.append(e)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=0.04, radius2=0.04, depth=0.18)
        for v in bm.verts: v.co.x *= 1.5
        e2 = C.make_obj('ExhaustInner', bm, mat_idx=mi('BlackPlastic'))
        e2.rotation_euler = (math.radians(90), 0, 0); e2.location = (sx * 0.52, -2.645, 0.40)
        out.append(e2)
    return out


def interior():
    out = []
    def bx(name, center, size, mat, taper=None, bevel=0.02, levels=1, rot=None):
        bm = bmesh.new(); C.box_bm(bm, center, size, taper=taper)
        o = C.make_obj(name, bm, mat_idx=mi(mat))
        C.activate(o)
        b = o.modifiers.new('bev', 'BEVEL'); b.width = bevel; b.segments = 3
        if levels > 0:
            s = o.modifiers.new('sub', 'SUBSURF'); s.levels = levels; s.render_levels = levels
        C.apply_modifiers(o)
        for p in o.data.polygons: p.use_smooth = True
        if rot is not None:
            o.rotation_euler = rot
        out.append(o); return o
    bx('Floor', (0, -0.50, 0.335), (1.74, 4.05, 0.04), 'Trim', bevel=0.005, levels=0)
    bx('Dash', (0, 0.73, 0.84), (1.86, 0.44, 0.50), 'Trim', bevel=0.05)
    bx('DashTop', (0, 0.76, 1.095), (1.84, 0.36, 0.03), 'Trim', bevel=0.012)
    bx('Binnacle', (-0.40, 0.76, 1.255), (0.56, 0.26, 0.18), 'Trim', bevel=0.03)
    bx('Screen', (0.02, 0.56, 1.05), (0.46, 0.035, 0.27), 'BlackPlastic', bevel=0.012, levels=0)
    bx('Vents', (0, 0.535, 0.88), (0.88, 0.03, 0.07), 'BlackPlastic', bevel=0.01, levels=0)
    bx('Console', (0, 0.0, 0.66), (0.34, 1.10, 0.40), 'Interior', bevel=0.05)
    bx('ConsoleTop', (0, 0.12, 0.865), (0.30, 0.60, 0.03), 'Trim', bevel=0.01)
    bx('Tunnel', (0, -0.95, 0.56), (0.34, 1.2, 0.20), 'Interior', bevel=0.05)
    for sx in (-1, 1):
        x = sx * 0.40
        bx('SeatBase', (x, -0.05, 0.63), (0.52, 0.58, 0.20), 'Seat', bevel=0.06)
        bx('SeatBack', (x, -0.37, 0.99), (0.52, 0.16, 0.74), 'Seat', bevel=0.06)
        bx('Headrest', (x, -0.41, 1.45), (0.27, 0.11, 0.23), 'Seat', bevel=0.05)
        bx('Armrest', (sx * 0.875, 0.10, 0.98), (0.07, 0.95, 0.06), 'Seat', bevel=0.02)
        bx('DoorSill', (sx * 0.87, 0.10, 0.50), (0.10, 1.5, 0.05), 'Trim', bevel=0.01, levels=0)
    bx('RearSeat', (0, -1.20, 0.64), (1.48, 0.56, 0.22), 'Seat', bevel=0.06)
    bx('RearBack', (0, -1.48, 1.00), (1.48, 0.17, 0.74), 'Seat', bevel=0.06)
    for x in (-0.45, 0.0, 0.45):
        bx('RearHead', (x, -1.51, 1.46), (0.26, 0.10, 0.22), 'Seat', bevel=0.05)
    bx('CargoFloor', (0, -2.05, 0.83), (1.50, 1.05, 0.05), 'Interior', bevel=0.01, levels=0)
    bx('CargoSide', (0, -2.50, 1.12), (1.50, 0.04, 0.50), 'Interior', bevel=0.01, levels=0)
    return out


# ---- wheels: the shared builder, re-proportioned (large 22 inch rim, thin sidewall, many thin spokes) ----------------
def suv_wheel():
    root, parts = C.build_wheel()
    RIM_K, AX_K = 1.36, 1.20
    lip_old, lip_new, tread_old, tread_new = 0.232, 0.318, 0.335, TIRE_R
    for p in parts:
        is_tyre = p.name.startswith('Tire')
        for v in p.data.vertices:
            a, y, z = v.co.x, v.co.y, v.co.z
            r = math.hypot(y, z)
            if r > 1e-6:
                if is_tyre: rn = lip_new + (min(max(r, lip_old), tread_old) - lip_old) * (tread_new - lip_new) / (tread_old - lip_old)
                else: rn = r * RIM_K
                y *= rn / r; z *= rn / r
            v.co = Vector((a * AX_K, y, z))
    return root, parts


def main():
    C.reset()
    C.make_materials(paint=(0.42, 0.44, 0.47, 1))
    body = build_body()
    shell = body.copy(); shell.data = body.data.copy(); shell.name = 'ShellRef'; C.link(shell)
    glass = glass_panes(shell)
    shell.hide_render = True                      # reference surface only (decals / glass are projected onto it); coincident with the body
    if not C.arg('--nosolid'): solidify(body, THICK)
    if not C.arg('--nocut'):
        for cut in (cutters(), arch_cutters()):
            boolean_cut(body, cut)
            bpy.data.objects.remove(cut, do_unlink=True)
    classify(body)
    wheel_wells()
    details(shell)
    mirrors()
    roof_parts()
    interior()
    pillar_trims(shell)
    wheel_root, wheel_parts = suv_wheel()
    out = C.arg('--preview')
    glb = C.arg('--glb')
    if out:
        os.makedirs(out, exist_ok=True)
        C.place_wheels_preview(wheel_root, wheel_parts)
        C.setup_studio()
        for hn in (C.arg('--hide') or '').split(','):
            for o in bpy.data.objects:
                if hn and o.name.startswith(hn): o.hide_render = True
        C.render_preview(out, 'side', (16.0, -0.15, 0.95), (0, -0.15, 0.93), lens=90)
        C.render_preview(out, 'side2', (-16.0, -0.15, 0.95), (0, -0.15, 0.93), lens=90)
        C.render_preview(out, 'front34', (5.2, 6.4, 1.6), (0, 0.6, 0.95), lens=55)
        C.render_preview(out, 'rear34', (-5.6, -6.4, 2.2), (0, -0.3, 0.98), lens=50)
        C.render_preview(out, 'front', (0.0, 9.0, 1.2), (0, 0, 0.95), lens=70)
        C.render_preview(out, 'rear', (0.0, -9.0, 1.4), (0, 0, 0.95), lens=70)
        C.render_preview(out, 'top', (0.0, -0.01, 12), (0, 0, 0.9), lens=40)
        for o in bpy.data.objects:
            if o.name.startswith('GlassPanes'): o.hide_render = True
        C.render_preview(out, 'inside', (-0.40, -0.05, 1.44), (-0.75, 1.6, 1.45), lens=22)
        C.render_preview(out, 'inside3', (-0.40, -0.04, 1.52), (-0.40 - 5.2, -0.04 + 8.5, 1.52 + 1.0), lens=14, samples=16)
        C.render_preview(out, 'inside2', (-0.40, -0.05, 1.50), (-0.30, 1.6, 1.42), lens=14, samples=16)
        C.render_preview(out, 'nose', (2.5, 5.2, 1.1), (0, 2.3, 0.75), lens=40)
    if glb:
        bpy.data.objects.remove(shell, do_unlink=True)
        C.export_glb(glb)
        if C.arg('--stats'):
            rows = sorted(((len(o.data.polygons), o.name) for o in bpy.data.objects if o.type == 'MESH'), reverse=True)
            print('POLYS total', sum(r[0] for r in rows)); print('TOP', rows[:10])


if __name__ == '__main__':
    main()
