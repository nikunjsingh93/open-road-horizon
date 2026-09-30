"""
Procedural luxury SUV (Range Rover-like) for Open Road.
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
WHEELBASE = 2.99
TRACK = 1.70
TIRE_R = 0.39
HUB_Z = 0.39
FRONT_Y = WHEELBASE / 2
REAR_Y = -WHEELBASE / 2
ARCH_R = 0.462
WHEEL_SCALE = 0.39 / 0.335          # the shared wheel builder makes a 0.335 m tyre
THICK = 0.03                        # sheet-metal shell thickness
for k, v in dict(WHEELBASE=WHEELBASE, TRACK=TRACK, TIRE_R=TIRE_R, HUB_Z=HUB_Z, FRONT_Y=FRONT_Y, REAR_Y=REAR_Y, ARCH_R=ARCH_R, SPOKES=5, SPOKE_W=1.7).items():
    setattr(C, k, v)

YN, YP = -2.53, 2.53

# side profile tables: (y, value), y ascending ------------------------------------------------
W_ = [(-2.53, 0.80), (-2.50, 0.86), (-2.44, 0.915), (-2.30, 0.955), (-2.0, 0.98), (-1.5, 0.992), (-0.5, 0.997), (0.5, 0.997), (1.0, 0.995), (1.5, 0.99), (2.0, 0.978), (2.3, 0.95), (2.45, 0.91), (2.50, 0.86), (2.53, 0.79)]
ZB_ = [(-2.53, 0.50), (-2.47, 0.43), (-2.3, 0.36), (-2.0, 0.31), (-1.6, 0.285), (-1.0, 0.27), (0, 0.265), (1.0, 0.27), (1.6, 0.285), (2.0, 0.31), (2.3, 0.35), (2.45, 0.40), (2.53, 0.46)]
ZS_ = [(-2.53, 1.05), (-2.47, 1.26), (-2.3, 1.29), (-1.5, 1.29), (-0.6, 1.278), (0.1, 1.268), (0.6, 1.225), (0.95, 1.12), (1.3, 1.07), (2.0, 1.055), (2.3, 1.04), (2.45, 1.01), (2.53, 0.95)]
R_ = [(-2.53, 0.95), (-2.505, 1.15), (-2.47, 1.48), (-2.43, 1.74), (-2.39, 1.81), (-2.30, 1.838), (-2.1, 1.85), (-1.5, 1.86), (-0.5, 1.868), (-0.2, 1.862), (0.0, 1.84), (0.25, 1.74), (0.5, 1.55), (0.75, 1.36), (0.93, 1.20), (1.0, 1.15), (1.1, 1.128), (1.5, 1.108), (2.0, 1.092), (2.3, 1.072), (2.45, 1.04), (2.53, 1.0)]
GB_ = [(-2.53, 0.78), (-2.47, 0.86), (-2.3, 0.92), (-1.5, 0.935), (-0.5, 0.94), (0.3, 0.93), (0.7, 0.91), (0.93, 0.88)]     # greenhouse half width at the belt
GR_ = [(-2.53, 0.50), (-2.47, 0.55), (-2.4, 0.64), (-2.3, 0.72), (-1.8, 0.77), (-0.5, 0.78), (0.0, 0.76), (0.3, 0.73), (0.6, 0.71), (0.93, 0.70)]   # roof edge half width


def smooth01(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def half_profile(y):
    w = interp(W_, y); zb = interp(ZB_, y); zs = interp(ZS_, y); R = interp(R_, y)
    gb = interp(GB_, y); gr = interp(GR_, y)
    zs = min(zs, R - 0.035)
    b = smooth01(1.03, 0.86, y)                     # 0 = hood, 1 = greenhouse
    dz = R - zs
    # hood mode (points hug the bonnet surface) and greenhouse mode (tumblehome up to the roof)
    hood = [(0.94 * w, R - 0.014), (0.80 * w, R - 0.003), (0.62 * w, R), (0.32 * w, R), (0.0, R)]
    glass = [(gb, zs + 0.035 + 0.02 * dz / 0.6), (gb - (gb - gr) * 0.48, zs + 0.47 * dz), (gr, R - 0.055), (gr * 0.52, R - 0.012), (0.0, R)]
    up = [(hood[i][0] + (glass[i][0] - hood[i][0]) * b, hood[i][1] + (glass[i][1] - hood[i][1]) * b) for i in range(5)]
    # keep the shoulder point inside the body width
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


def body_ring(y):
    h = half_profile(y)
    # no centre-line vertices: bottom and top are single straight edges, so the end caps are plain quads (centre vertices give degenerate cap triangles)
    left = [Vector((-x, y, z)) for x, z in h[1:-1]]
    right = [Vector((x, y, z)) for x, z in reversed(h[1:-1])]
    return left + right


def loft_grid(name, rings, crease_cols, crease_ends):
    """Closed ring loft; the end caps are triangulated (an n-gon cap shatters under subdivision, degenerate quads give NaN normals)."""
    bm = bmesh.new()
    cl = bm.edges.layers.float.get('crease_edge') or bm.edges.layers.float.new('crease_edge')
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for j in range(n):
            bm.faces.new((vs[i][j], vs[i][(j + 1) % n], vs[i + 1][(j + 1) % n], vs[i + 1][j]))
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
    return C.new_obj_from_bm(name, bm)


def build_body():
    ys = [-2.53, -2.515, -2.49, -2.46, -2.43, -2.39, -2.33, -2.22, -2.05, -1.85, -1.6, -1.35, -1.1, -0.85, -0.62, -0.42, -0.22, -0.05, 0.12, 0.30, 0.48, 0.66, 0.80, 0.90, 0.97, 1.04, 1.16, 1.32, 1.50, 1.72, 1.95, 2.15, 2.30, 2.41, 2.47, 2.51, 2.53]
    rings = [body_ring(y) for y in ys]
    n = len(rings[0])
    cols = {}
    for j, v in CREASES.items():
        cols[j - 1] = v; cols[n - j] = v
    body = loft_grid('Body', rings, cols, 1.0)
    C.subsurf_apply(body, 2)
    C.smooth_shade(body)
    mark_sharp(body)
    for p in body.data.polygons:                  # the two end panels are flat: flat shading (smoothing them gives streaky normals)
        if all(abs(body.data.vertices[i].co.y) > 2.5295 for i in p.vertices): p.use_smooth = False
    return body


def mark_sharp(obj, ang=34):
    """hard edges (panel corners) stay crisp in the glTF: edges sharper than ang degrees are flagged sharp"""
    bm = C.mesh_bm(obj)
    lim = math.radians(ang)
    for e in bm.edges:
        if len(e.link_faces) == 2 and e.calc_face_angle(0.0) > lim: e.smooth = False
    bm.to_mesh(obj.data); bm.free()


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
SIDE_FRONT = [(0.60, 1.33), (-0.03, 1.75), (-0.40, 1.765), (-0.42, 1.33)]
SIDE_REAR = [(-0.545, 1.33), (-0.525, 1.765), (-1.85, 1.765), (-2.15, 1.72), (-2.235, 1.50), (-2.245, 1.34), (-1.4, 1.33)]
SCREEN = [(-0.79, 0.91), (0.79, 0.91), (0.685, 0.10), (-0.685, 0.10)]      # plan view (x, y)
TAILGLASS = [(-0.655, 1.42), (0.655, 1.42), (0.595, 1.72), (-0.595, 1.72)]      # (x, z) looking along y


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
        objs.append(prism('cSF', SIDE_FRONT, 'YZ', lo, hi))
        objs.append(prism('cSR', SIDE_REAR, 'YZ', lo, hi))
    objs.append(prism('cWS', SCREEN, 'XY', 1.0, 2.2))
    objs.append(prism('cTG', TAILGLASS, 'XZ', -2.75, -2.25))
    return join_objs(objs, 'Cutters')


def arch_cutters():
    objs = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (-1, 1):
            bpy.ops.mesh.primitive_cylinder_add(vertices=160, radius=ARCH_R, depth=0.66, location=(sx * (0.95 + 0.0), sy, HUB_Z), rotation=(0, math.radians(90), 0))
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
    pf, pr = expand(SIDE_FRONT, 0.03), expand(SIDE_REAR, 0.03)
    ps, pt = expand(SCREEN, 0.03), expand(TAILGLASS, 0.03)
    for f in bm.faces:
        c = f.calc_center_median(); n = f.normal
        ok = False
        if abs(n.x) > 0.25 and abs(c.x) > 0.55 and n.x * c.x > 0 and c.z > 1.28:
            ok = C.point_in_poly(c.y, c.z, pf) or C.point_in_poly(c.y, c.z, pr)
        if not ok and n.z > 0.2 and n.y > -0.2 and c.z > 1.12 and c.y > 0.0 - 0.05 and c.y < 0.95:
            ok = C.point_in_poly(c.x, c.y, ps)
        if not ok and n.y < -0.35 and c.y < -2.3:
            ok = C.point_in_poly(c.x, c.z, pt)
        if ok: keep.append(f)
    kset = set(keep)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in kset], context='FACES')
    bm.verts.ensure_lookup_table()
    # move each vertex 14 mm against its normal
    bm.normal_update()
    for v in bm.verts: v.co -= v.normal * 0.014
    for f in bm.faces: f.material_index = mi('Glass'); f.smooth = True
    bm.to_mesh(d.data); bm.free()
    return d


def classify(body):
    """Outer-skin materials by position (black cladding, underbody, arch trim)."""
    bm = C.mesh_bm(body); bm.faces.ensure_lookup_table()
    for f in bm.faces:
        if f.material_index != 0: continue
        c = f.calc_center_median(); n = f.normal; ax = abs(c.x)
        if n.z < -0.6: f.material_index = mi('Underbody')
    # inner skin: door cards below the belt, headliner above it
    for f in bm.faces:
        if f.material_index == mi('Interior') and f.calc_center_median().z > 1.31: f.material_index = mi('Headliner')
    bm.to_mesh(body.data); bm.free()


def wheel_wells():
    out = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (-1, 1):
            bm = bmesh.new()
            R = ARCH_R + 0.028
            segs = 64
            x0, x1 = (0.66, 0.965) if sx > 0 else (-0.965, -0.66)
            rings = []
            for x in (x0, x1):
                rings.append([bm.verts.new((x, sy + R * cos(a), HUB_Z + R * sin(a))) for a in [2 * pi * i / segs for i in range(segs)]])
            for i in range(segs):
                j = (i + 1) % segs
                bm.faces.new((rings[0][i], rings[0][j], rings[1][j], rings[1][i]))
            cap = bm.faces.new(rings[0] if sx > 0 else list(reversed(rings[0])))
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
            o = C.make_obj('WheelWell', bm, mat_idx=mi('WheelWell'))
            out.append(o)
    return out


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


def details(shell):
    objs = []
    D = lambda *a, **k: objs.append(C.decal(*a, **k))
    fy, ty = 2.7, -2.7
    # ---------------- front ----------------
    D('Valance', [(-0.80, 0.56), (0.80, 0.56), (0.80, 0.40), (-0.80, 0.40)], 'XZ', fy, shell, 'BlackPlastic', offset=0.0018)
    D('Grille', [(-0.47, 0.935), (0.47, 0.935), (0.47, 0.705), (-0.47, 0.705)], 'XZ', fy, shell, 'BlackPlastic', offset=0.003)
    D('GrilleFrame', [(-0.485, 0.95), (0.485, 0.95), (0.485, 0.690), (-0.485, 0.690)], 'XZ', fy, shell, 'Chrome', offset=0.0018)
    for k in range(6):
        z0 = 0.73 + k * 0.035
        D('Slat', [(-0.45, z0 + 0.012), (0.45, z0 + 0.012), (0.45, z0), (-0.45, z0)], 'XZ', fy, shell, 'Chrome', offset=0.0045)
    for sx in (-1, 1):
        hl = [(sx * 0.50, 0.965), (sx * 0.775, 0.968), (sx * 0.785, 0.855), (sx * 0.50, 0.835)]
        D('HeadBg', hl, 'XZ', fy, shell, 'BlackPlastic', offset=0.0035)
        hl2 = [(sx * 0.515, 0.953), (sx * 0.765, 0.957), (sx * 0.773, 0.868), (sx * 0.515, 0.850)]
        D('HeadLens', hl2, 'XZ', fy, shell, 'HeadLens', offset=0.0048)
        D('DRL', [(sx * 0.53, 0.940), (sx * 0.76, 0.944), (sx * 0.762, 0.924), (sx * 0.53, 0.920)], 'XZ', fy, shell, 'HeadLamp', offset=0.0058)
        D('HeadLamp', [(sx * 0.56, 0.895), (sx * 0.74, 0.899), (sx * 0.742, 0.876), (sx * 0.56, 0.872)], 'XZ', fy, shell, 'HeadLamp', offset=0.0058)
        # fog lights
        D('Fog', [(sx * (0.66 + 0.055 * cos(a * pi / 8)), 0.57 + 0.04 * sin(a * pi / 8)) for a in range(16)], 'XZ', fy, shell, 'Trim', offset=0.004)
        D('FogLens', [(sx * (0.66 + 0.04 * cos(a * pi / 8)), 0.57 + 0.028 * sin(a * pi / 8)) for a in range(16)], 'XZ', fy, shell, 'HeadLens', offset=0.0055)
    D('Skid', [(-0.46, 0.53), (0.46, 0.53), (0.40, 0.475), (-0.40, 0.475)], 'XZ', fy, shell, 'RimAlloy', offset=0.004)
    D('BadgeF', [(0.045 * cos(a * pi / 8), 0.965 + 0.022 * sin(a * pi / 8)) for a in range(16)], 'XZ', fy, shell, 'Chrome', offset=0.004)
    # cowl / wiper trough
    D('Cowl', [(-0.78, 0.98), (0.78, 0.98), (0.78, 0.925), (-0.78, 0.925)], 'XY', 1.6, shell, 'BlackPlastic', offset=0.002)
    # hood shut lines
    for sx in (-1, 1):
        C.curve_line('HoodLine', [(sx * 0.80, 1.02, 1.6), (sx * 0.84, 1.6, 1.6), (sx * 0.80, 2.2, 1.6), (sx * 0.70, 2.50, 1.6)], shell, mat='Trim', width=0.004, offset=0.0012, axis='z')
    C.curve_line('HoodFront', [(-0.70, 2.50, 1.6), (0.0, 2.52, 1.6), (0.70, 2.50, 1.6)], shell, mat='Trim', width=0.004, offset=0.0012, axis='z')
    # ---------------- rear ----------------
    D('RearBand', [(-0.80, 0.74), (0.80, 0.74), (0.80, 0.48), (-0.80, 0.48)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0018)
    D('RearPlateBg', [(-0.30, 0.935), (0.30, 0.935), (0.30, 0.785), (-0.30, 0.785)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0028)
    D('Plate', [(-0.26, 0.925), (0.26, 0.925), (0.26, 0.798), (-0.26, 0.798)], 'XZ', ty, shell, 'Plate', offset=0.0045)
    D('TailBadge', [(-0.23, 1.055), (0.23, 1.055), (0.23, 1.025), (-0.23, 1.025)], 'XZ', ty, shell, 'Chrome', offset=0.004)
    for sx in (-1, 1):
        D('TailBg', [(sx * 0.66, 1.66), (sx * 0.81, 1.66), (sx * 0.84, 0.90), (sx * 0.66, 0.90)], 'XZ', ty, shell, 'BlackPlastic', offset=0.0028)
        D('TailVert', [(sx * 0.675, 1.64), (sx * 0.795, 1.64), (sx * 0.82, 0.92), (sx * 0.675, 0.92)], 'XZ', ty, shell, 'TailLamp', offset=0.0042)
        D('RevLight', [(sx * 0.58, 0.70), (sx * 0.74, 0.70), (sx * 0.74, 0.62), (sx * 0.58, 0.62)], 'XZ', ty, shell, 'HeadLens', offset=0.0045)
        D('RearRefl', [(sx * 0.64, 0.56), (sx * 0.77, 0.56), (sx * 0.77, 0.52), (sx * 0.64, 0.52)], 'XZ', ty, shell, 'TailLamp', offset=0.0045)
    D('TailBar', [(-0.66, 1.33), (0.66, 1.33), (0.66, 1.31), (-0.66, 1.31)], 'XZ', ty, shell, 'Trim', offset=0.0028)
    # ---------------- sides ----------------
    for sx in (-1, 1):
        X = sx * 1.4
        # sill + arch trims
        D('Sill', [(-0.97, 0.405), (0.98, 0.405), (0.98, 0.285), (-0.97, 0.285)], 'YZ', X, shell, 'BlackPlastic', offset=0.0022)
        D('SillChrome', [(-0.97, 0.415), (0.98, 0.415), (0.98, 0.405), (-0.97, 0.405)], 'YZ', X, shell, 'Chrome', offset=0.0032)
        for ay in (FRONT_Y, REAR_Y):
            pts = [(X, ay + (ARCH_R + 0.028) * cos(a), HUB_Z + (ARCH_R + 0.028) * sin(a)) for a in [pi * i / 40 for i in range(0, 41)]]
            C.curve_line('ArchTrim', pts, shell, mat='BlackPlastic', width=0.05, offset=0.0028, axis='x')
        # door cuts
        C.curve_line('DoorF', [(X, 0.93, 0.36), (X, 0.97, 0.80), (X, 0.92, 1.12), (X, 0.78, 1.28)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        C.curve_line('DoorM', [(X, -0.50, 0.36), (X, -0.50, 0.90), (X, -0.50, 1.30)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        C.curve_line('DoorR', [(X, -1.06, 0.36), (X, -1.08, 0.80), (X, -1.10, 1.30)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        C.curve_line('DoorLow', [(X, 0.93, 0.385), (X, -1.06, 0.385)], shell, mat='Trim', width=0.0045, offset=0.0014, axis='x')
        # handles (flush, silver) + black pillar
        D('HandleF', [(0.06, 1.17), (-0.26, 1.17), (-0.26, 1.145), (0.06, 1.145)], 'YZ', X, shell, 'Chrome', offset=0.004)
        D('HandleR', [(-0.72, 1.17), (-1.02, 1.17), (-1.02, 1.145), (-0.72, 1.145)], 'YZ', X, shell, 'Chrome', offset=0.004)
        D('BPillar', [(-0.415, 1.78), (-0.545, 1.78), (-0.545, 1.29), (-0.415, 1.29)], 'YZ', X, shell, 'BlackPlastic', offset=0.0035)
        # belt chrome under the glass
        C.curve_line('BeltChrome', [(X, 0.62, 1.303), (X, 0.0, 1.312), (X, -1.0, 1.312), (X, -2.22, 1.318)], shell, mat='Chrome', width=0.012, offset=0.004, axis='x')
        # front fender vent blade + side repeater
        D('FenderVent', [(0.66, 1.02), (0.92, 1.02), (0.92, 0.96), (0.66, 0.96)], 'YZ', X, shell, 'BlackPlastic', offset=0.003)
        D('Repeater', [(1.94, 0.86), (2.04, 0.86), (2.04, 0.83), (1.94, 0.83)], 'YZ', X, shell, 'Amber', offset=0.004)
    return objs


def mirrors():
    out = []
    for sx in (-1, 1):
        yaw = sx * math.radians(-8)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.30; v.co.y *= 0.19; v.co.z *= 0.17
        m = C.make_obj('MirrorHousing', bm, mat_idx=mi('CarPaint'))
        m.location = (sx * 1.075, 0.88, 1.36)
        m.rotation_euler = (0, 0, yaw)
        for p in m.data.polygons: p.use_smooth = True
        out.append(m)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=16, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.255; v.co.y *= 0.03; v.co.z *= 0.135
        g = C.make_obj('MirrorGlass', bm, mat_idx=mi('MirrorGlass'))
        off = Vector((0, -0.088, 0)); off.rotate(Matrix.Rotation(yaw, 3, 'Z'))
        g.location = Vector((sx * 1.075, 0.88, 1.36)) + off
        g.rotation_euler = (0, 0, yaw)
        for p in g.data.polygons: p.use_smooth = True
        out.append(g)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=12, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.22; v.co.y *= 0.14; v.co.z *= 0.05
        cap = C.make_obj('MirrorCap', bm, mat_idx=mi('BlackPlastic'))
        cap.location = (sx * 1.075, 0.885, 1.435); cap.rotation_euler = (0, 0, yaw)
        for p in cap.data.polygons: p.use_smooth = True
        out.append(cap)
        bm = bmesh.new()
        C.box_bm(bm, (0, 0, 0), (0.11, 0.05, 0.05))
        s = C.make_obj('MirrorStalk', bm, mat_idx=mi('BlackPlastic'))
        s.location = (sx * 0.96, 0.90, 1.32)
        out.append(s)
    return out


def roof_parts():
    out = []
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=0.018, radius2=0.018, depth=1.55)
        r = C.make_obj('RoofRail', bm, mat_idx=mi('RimAlloy'))
        r.rotation_euler = (math.radians(90), 0, 0)
        r.location = (sx * 0.655, -1.0, 1.875)
        for p in r.data.polygons: p.use_smooth = True
        out.append(r)
        for yy in (-0.3, -1.0, -1.72):
            bm = bmesh.new(); C.box_bm(bm, (0, 0, 0), (0.04, 0.05, 0.03))
            f = C.make_obj('RailFoot', bm, mat_idx=mi('BlackPlastic')); f.location = (sx * 0.655, yy, 1.855); out.append(f)
    bm = bmesh.new()
    C.box_bm(bm, (0, 0, 0), (1.18, 0.17, 0.045), taper=(0.97, 0.8))
    o = C.make_obj('RoofSpoiler', bm, mat_idx=mi('CarPaint'))
    C.activate(o)
    b = o.modifiers.new('bev', 'BEVEL'); b.width = 0.012; b.segments = 3
    s = o.modifiers.new('sub', 'SUBSURF'); s.levels = 1; s.render_levels = 1
    C.apply_modifiers(o)
    for p in o.data.polygons: p.use_smooth = True
    o.location = (0, -2.31, 1.845)
    out.append(o)
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=40, radius1=0.05, radius2=0.05, depth=0.17)
        for v in bm.verts: v.co.x *= 1.5
        e = C.make_obj('ExhaustTip', bm, mat_idx=mi('Chrome'))
        e.rotation_euler = (math.radians(90), 0, 0); e.location = (sx * 0.52, -2.50, 0.38)
        for p in e.data.polygons: p.use_smooth = True
        out.append(e)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=0.04, radius2=0.04, depth=0.18)
        for v in bm.verts: v.co.x *= 1.5
        e2 = C.make_obj('ExhaustInner', bm, mat_idx=mi('BlackPlastic'))
        e2.rotation_euler = (math.radians(90), 0, 0); e2.location = (sx * 0.52, -2.505, 0.38)
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
    bx('Binnacle', (-0.40, 0.76, 1.165), (0.56, 0.26, 0.18), 'Trim', bevel=0.03)
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
    bx('CargoFloor', (0, -2.00, 0.83), (1.50, 0.96, 0.05), 'Interior', bevel=0.01, levels=0)
    bx('CargoSide', (0, -2.42, 1.10), (1.50, 0.04, 0.50), 'Interior', bevel=0.01, levels=0)
    return out


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
    else:
        pass
    classify(body)
    wheel_wells()
    details(shell)
    mirrors()
    roof_parts()
    interior()
    wheel_root, wheel_parts = C.build_wheel()
    wheel_root.scale = (WHEEL_SCALE,) * 3
    out = C.arg('--preview')
    glb = C.arg('--glb')
    if out:
        os.makedirs(out, exist_ok=True)
        C.place_wheels_preview(wheel_root, wheel_parts)
        for e in bpy.data.objects:
            if e.name.startswith('WheelInst'): e.scale = (WHEEL_SCALE,) * 3
        C.setup_studio()
        C.render_preview(out, 'side', (11.0, 0.0, 1.1), (0, 0, 0.95), lens=50)
        C.render_preview(out, 'rear34', (-6.0, -6.4, 2.4), (0, 0, 0.95), lens=40)
        C.render_preview(out, 'front34', (6.0, 6.6, 2.0), (0, 0, 0.95), lens=40)
        C.render_preview(out, 'top', (0.0, -0.01, 12), (0, 0, 0.9), lens=40)
        C.render_preview(out, 'nose', (2.5, 5.0, 1.1), (0, 2.5, 0.75), lens=40)
        C.render_preview(out, 'inside', (-0.42, -0.1, 1.42), (-0.2, 3.0, 1.2), lens=26)
    if glb:
        bpy.data.objects.remove(shell, do_unlink=True)
        if C.arg('--stats'):
            rows = sorted(((len(o.data.polygons), o.name) for o in bpy.data.objects if o.type == 'MESH'), reverse=True)
            print('POLYS total', sum(r[0] for r in rows)); print('TOP', rows[:14])
        C.export_glb(glb)


if __name__ == '__main__':
    main()
