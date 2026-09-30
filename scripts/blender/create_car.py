"""
Procedural sports-coupe generator for Open Road.
Run:  blender --background --python create_car.py -- [--preview out_dir] [--glb path]
Conventions: Blender Z-up, car front = +Y  ->  glTF front = -Z (matches the game).
Origin: ground plane between the axles (z=0 is the tyre contact patch).
"""
import bpy, bmesh, math, sys, os
from math import sin, cos, pi, atan2, sqrt
from mathutils import Vector, Matrix
from mathutils.geometry import intersect_point_line

ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        return ARGS[i + 1] if i + 1 < len(ARGS) else True
    return default

# ----------------------------------------------------------------------------------------------
# Parameters (metres)
# ----------------------------------------------------------------------------------------------
WHEELBASE = 2.74
TRACK = 1.58
TIRE_R = 0.335
TIRE_W = 0.235
RIM_R = 0.228
HUB_Z = TIRE_R
FRONT_Y = WHEELBASE / 2
REAR_Y = -WHEELBASE / 2
ARCH_R = 0.392

def interp(keys, y):
    """Catmull-Rom interpolation over sorted (y, v) keys."""
    if y <= keys[0][0]: return keys[0][1]
    if y >= keys[-1][0]: return keys[-1][1]
    for i in range(len(keys) - 1):
        if keys[i][0] <= y <= keys[i + 1][0]:
            y0, v0 = keys[i]; y1, v1 = keys[i + 1]
            t = (y - y0) / (y1 - y0)
            pm = keys[i - 1][1] if i > 0 else v0 - (v1 - v0)
            pn = keys[i + 2][1] if i + 2 < len(keys) else v1 + (v1 - v0)
            t2, t3 = t * t, t * t * t
            m0 = (v1 - pm) * 0.5 * (y1 - y0) / max(y1 - keys[i - 1][0], 1e-6) * 2 if i > 0 else (v1 - v0)
            m1 = (pn - v0) * 0.5 * (y1 - y0) / max(keys[i + 2][0] - y0, 1e-6) * 2 if i + 2 < len(keys) else (v1 - v0)
            return (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
    return keys[-1][1]

# ----------------------------------------------------------------------------------------------
# Scene helpers
# ----------------------------------------------------------------------------------------------
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

MATS = {}
MAT_ORDER = ['CarPaint', 'Glass', 'BlackPlastic', 'Trim', 'Chrome', 'Rubber', 'RimAlloy', 'BrakeDisc', 'Caliper', 'HeadLens',
             'HeadLamp', 'TailLamp', 'WheelWell', 'Interior', 'Headliner', 'Seat', 'Plate', 'Underbody', 'MirrorGlass']

def material(name, color=(0.8, 0.8, 0.8, 1), metallic=0.0, rough=0.5, coat=0.0, coat_rough=0.03, emit=None, emit_strength=0.0, alpha=1.0, ior=1.45):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = color
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    for k, v in (('Coat Weight', coat), ('Coat Roughness', coat_rough), ('Alpha', alpha), ('IOR', ior)):
        if k in b.inputs: b.inputs[k].default_value = v
    if emit is not None:
        b.inputs['Emission Color'].default_value = emit
        b.inputs['Emission Strength'].default_value = emit_strength
    MATS[name] = m
    return m

def make_materials(paint=(0.42, 0.015, 0.02, 1)):
    material('CarPaint', paint, metallic=0.8, rough=0.3, coat=1.0, coat_rough=0.02)
    material('Glass', (0.02, 0.03, 0.035, 1), rough=0.03, alpha=0.35, ior=1.5)
    material('BlackPlastic', (0.015, 0.015, 0.017, 1), rough=0.55)
    material('Trim', (0.02, 0.02, 0.022, 1), rough=0.35)
    material('Chrome', (0.9, 0.9, 0.92, 1), metallic=1.0, rough=0.08)
    material('Rubber', (0.012, 0.012, 0.013, 1), rough=0.88)
    material('RimAlloy', (0.62, 0.63, 0.66, 1), metallic=1.0, rough=0.22)
    material('BrakeDisc', (0.32, 0.32, 0.34, 1), metallic=1.0, rough=0.45)
    material('Caliper', (0.75, 0.05, 0.03, 1), metallic=0.2, rough=0.4)
    material('HeadLens', (0.85, 0.9, 1.0, 1), rough=0.02, alpha=0.5)
    material('HeadLamp', (1, 1, 1, 1), emit=(1, 0.95, 0.85, 1), emit_strength=4.0)
    material('TailLamp', (0.6, 0.0, 0.0, 1), rough=0.1, emit=(1, 0.02, 0.01, 1), emit_strength=0.0)
    material('WheelWell', (0.006, 0.006, 0.007, 1), rough=0.9)
    material('Headliner', (0.2, 0.2, 0.21, 1), rough=0.85)
    material('MirrorGlass', (0.02, 0.03, 0.045, 1), rough=0.04)
    material('Interior', (0.05, 0.045, 0.045, 1), rough=0.7)
    material('Seat', (0.09, 0.07, 0.06, 1), rough=0.55)
    material('Plate', (0.85, 0.85, 0.8, 1), rough=0.4)
    material('Underbody', (0.008, 0.008, 0.009, 1), rough=0.9)

def mi(name):  # material index in the shared slot list
    return MAT_ORDER.index(name)

def link(obj, coll=None):
    (coll or bpy.context.scene.collection).objects.link(obj)
    return obj

def set_all_mats(mesh):
    mesh.materials.clear()
    for n in MAT_ORDER: mesh.materials.append(MATS[n])

def new_obj_from_bm(name, bm):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh); bm.free()
    set_all_mats(mesh)
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    return obj

def activate(obj):
    for o in bpy.context.selected_objects: o.select_set(False)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)

def apply_modifiers(obj):
    activate(obj)
    for m in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)

def loft(name, rings, crease_cols=None, crease_ends=0.0, cap_start=True, cap_end=True, mat='CarPaint'):
    bm = bmesh.new()
    cl = bm.edges.layers.float.get('crease_edge') or bm.edges.layers.float.new('crease_edge')
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for j in range(n):
            f = bm.faces.new((vs[i][j], vs[i][(j + 1) % n], vs[i + 1][(j + 1) % n], vs[i + 1][j]))
            f.material_index = mi(mat)
    if cap_start:
        f = bm.faces.new(vs[0]); f.material_index = mi(mat)
    if cap_end:
        f = bm.faces.new(list(reversed(vs[-1]))); f.material_index = mi(mat)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.edges.ensure_lookup_table()
    if crease_cols:
        for j, cv in crease_cols.items():
            for i in range(len(rings) - 1):
                e = bm.edges.get((vs[i][j], vs[i + 1][j]))
                if e: e[cl] = cv
    if crease_ends > 0:
        for ring_i in (0, len(rings) - 1):
            for j in range(n):
                e = bm.edges.get((vs[ring_i][j], vs[ring_i][(j + 1) % n]))
                if e: e[cl] = crease_ends
    return new_obj_from_bm(name, bm)

def subsurf_apply(obj, levels=3):
    m = obj.modifiers.new('sub', 'SUBSURF')
    m.levels = levels; m.render_levels = levels
    m.subdivision_type = 'CATMULL_CLARK'
    activate(obj)
    bpy.ops.object.modifier_apply(modifier=m.name)

def smooth_shade(obj):
    for p in obj.data.polygons: p.use_smooth = True

# ----------------------------------------------------------------------------------------------
# Body
# ----------------------------------------------------------------------------------------------
Y0, Y1 = -2.29, 2.29
TOP = [(-2.29, 0.86), (-2.22, 0.925), (-2.05, 0.99), (-1.9, 1.02), (-1.7, 1.035), (-1.2, 1.03), (-0.5, 1.00), (0.3, 0.98), (0.9, 0.955), (1.5, 0.885), (1.9, 0.795), (2.15, 0.705), (2.29, 0.635)]
SHO = [(-2.29, 0.82), (-2.22, 0.89), (-2.05, 0.96), (-1.9, 0.99), (-1.7, 1.0), (-1.2, 0.99), (-0.5, 0.97), (0.3, 0.95), (0.9, 0.925), (1.5, 0.855), (1.9, 0.765), (2.15, 0.68), (2.29, 0.61)]
BOT = [(-2.29, 0.40), (-2.22, 0.32), (-2.0, 0.24), (-1.7, 0.20), (-1.2, 0.17), (-0.5, 0.16), (0.3, 0.16), (0.9, 0.17), (1.5, 0.19), (1.9, 0.20), (2.15, 0.235), (2.29, 0.30)]
WID = [(-2.29, 0.66), (-2.22, 0.76), (-2.1, 0.86), (-1.95, 0.915), (-1.6, 0.945), (-1.37, 0.948), (-0.9, 0.93), (-0.3, 0.915), (0.4, 0.915), (0.9, 0.93), (1.37, 0.945), (1.8, 0.925), (2.05, 0.875), (2.2, 0.80), (2.29, 0.73)]

def body_half(y):
    zb = interp(BOT, y); zs = interp(SHO, y); zt = interp(TOP, y); w = interp(WID, y)
    return [
        (0.0, zb),
        (0.68 * w, zb),
        (0.955 * w, zb + 0.055),        # 2 rocker
        (1.0 * w, zb + 0.20),
        (1.0 * w, zs - 0.17),
        (0.985 * w, zs - 0.035),
        (0.90 * w, zs),                 # 6 shoulder crease
        (0.68 * w, zt - 0.012),
        (0.36 * w, zt - 0.003),
        (0.0, zt),
    ]

CREASE_LEFT = {2: 0.55, 6: 0.8}

def body_ring(y):
    h = body_half(y)
    left = [Vector((-x, y, z)) for x, z in h]                 # bottom-centre -> top-centre, x<0
    right = [Vector((x, y, z)) for x, z in reversed(h[1:-1])]  # top-centre -> bottom (excl. duplicates)
    return left + right

def build_body():
    ys = [Y0]
    for i in range(0, 41):
        t = i / 40
        ys.append(Y0 + 0.035 + (Y1 - Y0 - 0.07) * t)
    ys.append(Y1)
    rings = [body_ring(y) for y in ys]
    n_half = len(body_half(0))
    n = len(rings[0])
    cols = {}
    for j, v in CREASE_LEFT.items():
        cols[j] = v
        cols[n - j] = v      # mirrored index on right side
    body = loft('Body', rings, crease_cols=cols, crease_ends=0.5)
    return body

# Greenhouse ---------------------------------------------------------------------------------
ROOF = [(-1.70, 0.990), (-1.45, 1.045), (-1.1, 1.150), (-0.7, 1.262), (-0.35, 1.315), (0.0, 1.327), (0.22, 1.31), (0.47, 1.225), (0.72, 1.105), (0.98, 0.985)]
WB = [(-1.7, 0.66), (-1.4, 0.82), (-0.9, 0.87), (-0.2, 0.875), (0.4, 0.865), (0.8, 0.83), (1.0, 0.72)]
WT = [(-1.7, 0.50), (-1.4, 0.58), (-0.9, 0.62), (-0.2, 0.655), (0.3, 0.655), (0.7, 0.60), (1.0, 0.52)]
BELT = [(-1.7, 0.99), (-1.2, 0.985), (-0.5, 0.965), (0.3, 0.945), (1.0, 0.92)]

def cabin_half(y):
    zt = interp(ROOF, y); wb = interp(WB, y); wt = interp(WT, y); zbelt = interp(BELT, y)
    zt = max(zt, zbelt + 0.006)
    zbase = 0.90
    hgt = zt - zbelt
    return [
        (wb, zbase),
        (wb * 0.995, zbelt),                                   # 1 belt crease
        (wb - (wb - wt) * 0.35, zbelt + hgt * 0.35),
        (wb - (wb - wt) * 0.75, zbelt + hgt * 0.78),
        (wt + 0.012, zt - 0.03),                               # 4 roof edge (soft crease)
        (wt * 0.80, zt - 0.006),
        (wt * 0.42, zt - 0.001),
        (0.0, zt),
    ]

def cabin_ring(y):
    h = cabin_half(y)
    left = [Vector((-x, y, z)) for x, z in h]                 # bottom(left) -> top-centre
    right = [Vector((x, y, z)) for x, z in reversed(h[:-1])]  # right side top->bottom
    return left + right

def build_cabin():
    ys = [-1.70 + (0.98 + 1.70) * (i / 44) for i in range(45)]
    rings = [cabin_ring(y) for y in ys]
    n = len(rings[0])
    cols = {1: 0.7, n - 1: 0.7, 4: 0.35, n - 4: 0.35}
    cabin = loft('Cabin', rings, crease_cols=cols, crease_ends=0.0, cap_start=True, cap_end=True)
    return cabin

# ----------------------------------------------------------------------------------------------
def mesh_bm(obj):
    bm = bmesh.new(); bm.from_mesh(obj.data); return bm

def face_center(f): return f.calc_center_median()

def point_in_poly(px, py, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]; xj, yj = poly[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi + 1e-12) + xi):
            inside = not inside
        j = i
    return inside

def cabin_glass(obj):
    """Assign glass to windshield / side / rear windows, keep pillars painted, recess the glass."""
    bm = mesh_bm(obj)
    bm.faces.ensure_lookup_table()
    side_poly = [(0.86, 0.985), (0.24, 1.285), (-0.05, 1.305), (-0.62, 1.245), (-1.02, 1.09), (-1.12, 1.03), (-0.9, 0.995), (0.55, 0.995)]
    glass = []
    for f in bm.faces:
        c = face_center(f); n = f.normal
        if c.z < 1.0: continue
        g = False
        if abs(n.x) > 0.5:
            g = point_in_poly(c.y, c.z, side_poly)
            # shrink towards the belt so frame stays visible
        elif n.y > 0.32 and n.z > 0.25:                     # windshield
            g = abs(c.x) < interp(WT, c.y) - 0.055 and c.z > interp(BELT, c.y) + 0.02
        elif n.y < -0.28 and n.z > 0.2:                     # rear window
            g = abs(c.x) < interp(WT, c.y) - 0.07 and c.z > interp(BELT, c.y) + 0.02
        if g:
            f.material_index = mi('Glass'); glass.append(f)
    if glass:
        r = bmesh.ops.inset_region(bm, faces=glass, thickness=0.010, depth=-0.006, use_even_offset=True)
    bm.to_mesh(obj.data); bm.free()

def body_pass(obj):
    """Wheel wells, arches, underbody & plastic lower trim by classification."""
    # open the cabin: remove the deck surface that sits under the greenhouse so the interior is visible/usable
    bm = mesh_bm(obj); bm.faces.ensure_lookup_table()
    dead = [f for f in bm.faces if abs(face_center(f).x) < 0.80 and -1.58 < face_center(f).y < 0.90 and face_center(f).z > 0.86 and f.normal.z > 0.2]
    bmesh.ops.delete(bm, geom=dead, context='FACES')
    bm.to_mesh(obj.data); bm.free()
    # arch cutters ------------------------------------------------------------------
    cutters = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (-1, 1):
            bpy.ops.mesh.primitive_cylinder_add(vertices=192, radius=ARCH_R, depth=0.62, location=(sx * (TRACK / 2 + 0.06), sy, HUB_Z), rotation=(0, math.radians(90), 0))
            c = bpy.context.active_object; cutters.append(c)
    activate(cutters[0])
    for c in cutters[1:]: c.select_set(True)
    bpy.ops.object.join()
    cut = bpy.context.active_object
    cut.name = 'ArchCutter'
    bm = bmesh.new(); bm.from_mesh(obj.data)
    activate(obj)
    mod = obj.modifiers.new('arches', 'BOOLEAN')
    mod.operation = 'DIFFERENCE'; mod.object = cut; mod.solver = 'EXACT'
    bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.data.objects.remove(cut, do_unlink=True)
    bm.free()
    # classification --------------------------------------------------------------
    bm = mesh_bm(obj)
    bm.faces.ensure_lookup_table()
    for f in bm.faces:
        c = face_center(f); n = f.normal
        ax = abs(c.x)
        dyF = math.hypot(c.y - FRONT_Y, c.z - HUB_Z); dyR = math.hypot(c.y - REAR_Y, c.z - HUB_Z)
        dmin = min(dyF, dyR)
        if ax > 0.30 and ((dmin < ARCH_R + 0.004 and abs(n.x) < 0.6) or (dmin < ARCH_R - 0.004 and ax < 0.66)):
            f.material_index = mi('WheelWell')
        elif n.z < -0.6:
            f.material_index = mi('Underbody')
        elif c.y > 2.05 and c.z < 0.29:
            f.material_index = mi('BlackPlastic')      # front splitter / lower valance
        elif c.y < -2.0 and c.z < 0.40 and n.z < 0.2:
            f.material_index = mi('BlackPlastic')      # rear diffuser
        elif ax > 0.80 and c.z < 0.245 and abs(c.y) < 1.0:
            f.material_index = mi('BlackPlastic')      # side sills
    bm.to_mesh(obj.data); bm.free()

# ----------------------------------------------------------------------------------------------
# Detail geometry: wheels, decal patches, lights, mirrors, exhaust, interior
# ----------------------------------------------------------------------------------------------
def make_obj(name, bm, mats=None, mat_idx=None):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh); bm.free()
    set_all_mats(mesh)
    if mat_idx is not None:
        for p in mesh.polygons: p.material_index = mat_idx
    obj = bpy.data.objects.new(name, mesh)
    link(obj)
    return obj

def revolve(profile, segments=96, axis='X', mat='Rubber', name='rev', close=False):
    """profile: list of (axial, radial) points; spun around the X axis."""
    bm = bmesh.new()
    verts = []
    for (a, r) in profile:
        verts.append(bm.verts.new((a, r, 0)))
    edges = [bm.edges.new((verts[i], verts[i + 1])) for i in range(len(verts) - 1)]
    if close: edges.append(bm.edges.new((verts[-1], verts[0])))
    bmesh.ops.spin(bm, geom=list(bm.verts) + list(bm.edges), cent=(0, 0, 0), axis=(1, 0, 0), angle=2 * pi, steps=segments, use_merge=True)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # verify orientation: outermost face must point away from the spin axis
    far = max(bm.faces, key=lambda f: f.calc_center_median().yz.length)
    c = far.calc_center_median(); rad = Vector((0, c.y, c.z)).normalized()
    if far.normal.dot(rad) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    return make_obj(name, bm, mat_idx=mi(mat))

def box_bm(bm, center, size, rot=None, taper=None):
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    vs = [Vector(v) for v in ((-hx, -hy, -hz), (hx, -hy, -hz), (hx, hy, -hz), (-hx, hy, -hz), (-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz))]
    if taper:
        for v in vs:
            if v.z > 0: v.x *= taper[0]; v.y *= taper[1]
    if rot: vs = [rot @ v for v in vs]
    vs = [v + Vector(center) for v in vs]
    bv = [bm.verts.new(v) for v in vs]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([bv[i] for i in f])
    return bv

def build_wheel():
    parts = []
    # ---- tyre ----
    W2 = TIRE_W / 2
    prof = [(-W2 + 0.006, 0.232), (-W2, 0.245), (-W2 - 0.003, 0.275), (-W2 - 0.002, 0.305), (-W2 + 0.012, 0.327), (-0.085, 0.3345), (-0.078, 0.3315), (-0.070, 0.3345),
            (-0.032, 0.3350), (-0.026, 0.3315), (-0.020, 0.3350), (0.020, 0.3350), (0.026, 0.3315), (0.032, 0.3350),
            (0.070, 0.3345), (0.078, 0.3315), (0.085, 0.3345), (W2 - 0.012, 0.327), (W2 + 0.002, 0.305), (W2 + 0.003, 0.275), (W2, 0.245), (W2 - 0.006, 0.232)]
    tyre = revolve(prof, 120, mat='Rubber', name='Tire', close=True)
    # sidewall lettering-ish relief omitted; smooth shade
    for p in tyre.data.polygons: p.use_smooth = True
    parts.append(tyre)
    # ---- rim barrel ----
    rp = [(-0.098, 0.232), (-0.098, 0.222), (-0.09, 0.212), (-0.02, 0.208), (0.05, 0.208), (0.095, 0.216), (0.108, 0.229), (0.112, 0.233), (0.108, 0.236), (0.098, 0.2325)]
    barrel = revolve(rp, 96, mat='RimAlloy', name='RimBarrel', close=True)
    for p in barrel.data.polygons: p.use_smooth = True
    parts.append(barrel)
    # ---- rim face: dished disc + 10 twin-ish spokes ----
    bm = bmesh.new()
    n_sp = 10
    for k in range(n_sp):
        a = 2 * pi * k / n_sp
        rot = Matrix.Rotation(a, 3, 'X')
        # spoke: tapered box from hub to lip, slightly dished outward (toward +X)
        segs = 6
        prev = None
        for si in range(segs + 1):
            t = si / segs
            r = 0.05 + t * (0.212 - 0.05)
            xo = 0.105 - 0.045 * (1 - t) ** 1.5 - 0.02 * t          # axial position (dish)
            wdt = 0.036 + 0.030 * t                                 # tangential width
            thk = 0.020 - 0.006 * t
            # two verts pairs (front/back) each side
            pts = []
            for dx, dt in ((thk, -wdt / 2), (thk, wdt / 2), (-thk, wdt / 2), (-thk, -wdt / 2)):
                v = Vector((xo + dx / 2, r, dt))
                pts.append(bm.verts.new(rot @ v))
            if prev:
                for j in range(4):
                    bm.faces.new((prev[j], prev[(j + 1) % 4], pts[(j + 1) % 4], pts[j]))
            else:
                bm.faces.new(list(reversed(pts)))
            prev = pts
        bm.faces.new(prev)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    spokes = make_obj('RimSpokes', bm, mat_idx=mi('RimAlloy'))
    for p in spokes.data.polygons: p.use_smooth = True
    parts.append(spokes)
    # hub cap
    hp = [(0.0, 0.0), (0.045, 0.0), (0.06, 0.02), (0.07, 0.045), (0.06, 0.06), (0.03, 0.064), (0.0, 0.064)]
    hub = revolve([(a + 0.02, r) for a, r in hp], 48, mat='RimAlloy', name='RimHub', close=True)
    for p in hub.data.polygons: p.use_smooth = True
    parts.append(hub)
    # inner dark disc behind spokes (rim well)
    inner = revolve([(-0.02, 0.05), (-0.02, 0.21), (0.0, 0.21), (0.0, 0.05)], 64, mat='BrakeDisc', name='InnerDisc', close=True)
    parts.append(inner)
    # ---- brake disc ----
    disc = revolve([(-0.055, 0.075), (-0.055, 0.16), (-0.03, 0.166), (-0.03, 0.075)], 96, mat='BrakeDisc', name='Disc', close=True)
    for p in disc.data.polygons: p.use_smooth = True
    parts.append(disc)
    # ---- caliper ----
    bm = bmesh.new()
    box_bm(bm, (-0.045, 0.0, 0.0), (0.075, 0.11, 0.16), rot=None)
    cal = make_obj('Caliper', bm, mat_idx=mi('Caliper'))
    cal.location = (0, 0.0, 0)
    # place caliper on the disc at the top-rear (angle) by rotating verts around X
    rotm = Matrix.Rotation(math.radians(200), 4, 'X')
    for v in cal.data.vertices:
        v.co = rotm @ (v.co + Vector((0, 0, 0)) + Vector((0, 0.128, 0))) if False else rotm @ Vector((v.co.x, v.co.y, v.co.z + 0.128))
    parts.append(cal)
    # join all into one object per material is handled at export time: parent to an empty
    root = bpy.data.objects.new('Wheel', None)
    link(root)
    for p in parts:
        p.parent = root
    return root, parts

def place_wheels_preview(root, parts):
    """Instantiate 4 copies for preview renders (right side: outward +X)."""
    copies = []
    for sy in (FRONT_Y, REAR_Y):
        for sx in (-1, 1):
            e = bpy.data.objects.new('WheelInst', None); link(e)
            e.location = (sx * TRACK / 2, sy, HUB_Z)
            if sx < 0: e.rotation_euler = (0, 0, pi)
            for p in parts:
                dup = p.copy(); dup.data = p.data; dup.parent = e; link(dup)
            copies.append(e)
    return copies

# ---- decal patches shrink-wrapped onto the shell -------------------------------------------
def make_shell(*objs):
    dups = []
    for o in objs:
        d = o.copy(); d.data = o.data.copy(); link(d); dups.append(d)
    activate(dups[0])
    for d in dups[1:]: d.select_set(True)
    if len(dups) > 1: bpy.ops.object.join()
    shell = bpy.context.active_object
    shell.name = 'Shell'
    return shell

def decal(name, poly, plane, fixed, shell, mat, offset=0.0025, res=0.003, axis=None, thickness=0.0):
    """poly in 2D (a,b); plane 'XZ' => point (a, fixed, b), projects along Y; 'YZ' => (fixed, a, b) along X; 'XY' => (a,b,fixed) along Z."""
    minx = min(p[0] for p in poly); maxx = max(p[0] for p in poly)
    miny = min(p[1] for p in poly); maxy = max(p[1] for p in poly)
    nx = max(2, int((maxx - minx) / res)); ny = max(2, int((maxy - miny) / res))
    bm = bmesh.new()
    grid = {}
    for j in range(ny + 1):
        for i in range(nx + 1):
            a = minx + (maxx - minx) * i / nx; b = miny + (maxy - miny) * j / ny
            grid[(i, j)] = (a, b)
    vmap = {}
    def get(i, j):
        if (i, j) not in vmap:
            a, b = grid[(i, j)]
            p = (a, fixed, b) if plane == 'XZ' else ((fixed, a, b) if plane == 'YZ' else (a, b, fixed))
            vmap[(i, j)] = bm.verts.new(p)
        return vmap[(i, j)]
    for j in range(ny):
        for i in range(nx):
            ca = (grid[(i, j)][0] + grid[(i + 1, j)][0]) / 2; cb = (grid[(i, j)][1] + grid[(i, j + 1)][1]) / 2
            if point_in_poly(ca, cb, poly):
                bm.faces.new((get(i, j), get(i + 1, j), get(i + 1, j + 1), get(i, j + 1)))
    obj = make_obj(name, bm, mat_idx=mi(mat))
    sw = obj.modifiers.new('sw', 'SHRINKWRAP')
    sw.wrap_method = 'PROJECT'; sw.target = shell
    ax = axis or {'XZ': 'y', 'YZ': 'x', 'XY': 'z'}[plane]
    sw.use_project_x = ax == 'x'; sw.use_project_y = ax == 'y'; sw.use_project_z = ax == 'z'
    sw.use_negative_direction = True; sw.use_positive_direction = True
    sw.cull_face = 'OFF'; sw.offset = offset
    sw.project_limit = 0.0
    activate(obj); bpy.ops.object.modifier_apply(modifier=sw.name)
    for p in obj.data.polygons: p.use_smooth = True
    return obj

def curve_line(name, pts3, shell, mat='Trim', width=0.0045, offset=0.0015, res=0.01, axis='x'):
    """Panel line: ribbon following pts3 (list of 3D points) projected onto the shell."""
    bm = bmesh.new()
    # densify
    dense = []
    for a, b in zip(pts3[:-1], pts3[1:]):
        L = (Vector(b) - Vector(a)).length
        n = max(1, int(L / res))
        for i in range(n): dense.append(Vector(a).lerp(Vector(b), i / n))
    dense.append(Vector(pts3[-1]))
    # ribbon width direction: perpendicular to travel in the projection plane
    proj = {'x': Vector((1, 0, 0)), 'y': Vector((0, 1, 0)), 'z': Vector((0, 0, 1))}[axis]
    left = []; right = []
    for i, p in enumerate(dense):
        t = (dense[min(i + 1, len(dense) - 1)] - dense[max(i - 1, 0)]).normalized()
        s = t.cross(proj).normalized() * width / 2
        left.append(bm.verts.new(p + s)); right.append(bm.verts.new(p - s))
    for i in range(len(dense) - 1):
        bm.faces.new((left[i], left[i + 1], right[i + 1], right[i]))
    obj = make_obj(name, bm, mat_idx=mi(mat))
    sw = obj.modifiers.new('sw', 'SHRINKWRAP')
    sw.wrap_method = 'PROJECT'; sw.target = shell
    sw.use_project_x = axis == 'x'; sw.use_project_y = axis == 'y'; sw.use_project_z = axis == 'z'
    sw.use_negative_direction = True; sw.use_positive_direction = True
    sw.cull_face = 'OFF'; sw.offset = offset
    activate(obj); bpy.ops.object.modifier_apply(modifier=sw.name)
    for p in obj.data.polygons: p.use_smooth = True
    return obj

def mirror_x(pts): return [(-a, b) for a, b in pts]

def build_details(body, cabin):
    shell = make_shell(body, cabin)
    objs = []
    # ---------------- rear: tail lights ----------------
    tail_y = -2.5
    tl = [(-0.80, 0.845), (-0.55, 0.835), (-0.12, 0.79), (-0.12, 0.735), (-0.55, 0.75), (-0.80, 0.705)]
    objs.append(decal('TailL_bg', [(a * 1.0, b) for a, b in tl], 'XZ', tail_y, shell, 'Trim', offset=0.0015))
    tl_in = [(-0.785, 0.835), (-0.55, 0.826), (-0.135, 0.783), (-0.135, 0.744), (-0.55, 0.758), (-0.785, 0.716)]
    objs.append(decal('TailL', tl_in, 'XZ', tail_y, shell, 'TailLamp', offset=0.0035))
    objs.append(decal('TailR_bg', mirror_x(tl), 'XZ', tail_y, shell, 'Trim', offset=0.0015))
    objs.append(decal('TailR', mirror_x(tl_in), 'XZ', tail_y, shell, 'TailLamp', offset=0.0035))
    # centre strip
    strip = [(-0.13, 0.775), (0.13, 0.775), (0.13, 0.755), (-0.13, 0.755)]
    objs.append(decal('TailStrip', strip, 'XZ', tail_y, shell, 'TailLamp', offset=0.0035))
    # plate
    plate_bg = [(-0.31, 0.66), (0.31, 0.66), (0.31, 0.535), (-0.31, 0.535)]
    objs.append(decal('PlateFrame', plate_bg, 'XZ', tail_y, shell, 'Trim', offset=0.004))
    plate = [(-0.26, 0.645), (0.26, 0.645), (0.26, 0.55), (-0.26, 0.55)]
    objs.append(decal('Plate', plate, 'XZ', tail_y, shell, 'Plate', offset=0.006))
    # reverse lights
    for sx in (-1, 1):
        rv = [(sx * 0.62, 0.50), (sx * 0.72, 0.50), (sx * 0.72, 0.465), (sx * 0.62, 0.465)]
        objs.append(decal('Rev', rv, 'XZ', tail_y, shell, 'HeadLens', offset=0.004))
    # rear valance dark band
    # ---------------- front: grille, headlights ----------------
    front_y = 2.6
    grille = [(-0.46, 0.44), (-0.30, 0.455), (0.30, 0.455), (0.46, 0.44), (0.50, 0.36), (0.34, 0.325), (-0.34, 0.325), (-0.50, 0.36)]
    objs.append(decal('Grille', grille, 'XZ', front_y, shell, 'BlackPlastic', offset=0.003))
    # lower intakes
    for sx in (-1, 1):
        it = [(sx * 0.56, 0.40), (sx * 0.68, 0.415), (sx * 0.68, 0.335), (sx * 0.56, 0.325)]
        objs.append(decal('Intake', it, 'XZ', front_y, shell, 'BlackPlastic', offset=0.003))
    # headlights (side patches wrapped from front)
    for sx in (-1, 1):
        hl = [(sx * 0.72, 0.615), (sx * 0.52, 0.622), (sx * 0.28, 0.600), (sx * 0.26, 0.490), (sx * 0.48, 0.475), (sx * 0.72, 0.505)]
        objs.append(decal('HeadBg', hl, 'XZ', front_y, shell, 'Trim', offset=0.0015))
        hl_in = [(sx * 0.705, 0.604), (sx * 0.52, 0.610), (sx * 0.295, 0.589), (sx * 0.278, 0.503), (sx * 0.48, 0.488), (sx * 0.705, 0.516)]
        objs.append(decal('HeadLens', hl_in, 'XZ', front_y, shell, 'HeadLens', offset=0.0035))
        drl = [(sx * 0.69, 0.545), (sx * 0.32, 0.527), (sx * 0.32, 0.515), (sx * 0.69, 0.533)]
        objs.append(decal('HeadLamp', drl, 'XZ', front_y, shell, 'HeadLamp', offset=0.0055))
    # ---------------- panel lines ----------------
    for sx in (-1, 1):
        X = sx * 1.4
        # door front & rear vertical lines (side view; projected along X)
        curve_line('DoorFront', [(X, 0.55, 0.24), (X, 0.56, 0.60), (X, 0.50, 0.92)], shell, axis='x')
        curve_line('DoorRear', [(X, -0.72, 0.22), (X, -0.72, 0.60), (X, -0.72, 0.95), (X, -0.70, 1.05)], shell, axis='x')
        curve_line('DoorSill', [(X, 0.55, 0.25), (X, -0.72, 0.25)], shell, axis='x')
        # hood side lines (projected along Z)
        Z = 1.6
        curve_line('HoodLine', [(sx * 0.80, 0.9, Z), (sx * 0.80, 1.5, Z), (sx * 0.62, 2.0, Z), (sx * 0.5, 2.2, Z)], shell, axis='z', width=0.004)
    curve_line('HoodCowl', [(-0.82, 0.80, 1.6), (0.0, 0.82, 1.6), (0.82, 0.80, 1.6)], shell, axis='z', width=0.004)
    curve_line('TrunkLine', [(-0.85, -1.62, 1.6), (0.0, -1.66, 1.6), (0.85, -1.62, 1.6)], shell, axis='z', width=0.004)
    # door handles
    for sx in (-1, 1):
        hd = [(-0.62, 1.02), (-0.36, 1.02), (-0.36, 0.995), (-0.62, 0.995)]
        objs.append(decal('Handle', hd, 'YZ', sx * 1.4, shell, 'Trim', offset=0.004))
    bpy.data.objects.remove(shell, do_unlink=True)
    return objs

def build_mirrors():
    out = []
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.22; v.co.y *= 0.13; v.co.z *= 0.10
        m = make_obj('Mirror', bm, mat_idx=mi('CarPaint'))
        m.location = (sx * 1.0, 0.52, 1.03)
        m.rotation_euler = (0, 0, sx * math.radians(-10))
        for p in m.data.polygons: p.use_smooth = True
        out.append(m)
        # stalk
        bm = bmesh.new()
        box_bm(bm, (0, 0, 0), (0.09, 0.035, 0.022))
        s = make_obj('MirrorStalk', bm, mat_idx=mi('CarPaint'))
        s.location = (sx * 0.905, 0.53, 0.995)
        out.append(s)
        # mirror glass: thin lens on the rear face of the housing (housing is yawed the same way)
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=12, radius=0.5)
        for v in bm.verts:
            v.co.x *= 0.17; v.co.y *= 0.014; v.co.z *= 0.075
        g = make_obj('MirrorGlass', bm, mat_idx=mi('MirrorGlass'))
        yaw = sx * math.radians(-10)
        off = Vector((0, -0.066, 0)); off.rotate(Matrix.Rotation(yaw, 3, 'Z'))
        g.location = Vector((sx * 1.0, 0.52, 1.03)) + off
        g.rotation_euler = (0, 0, yaw)
        for p in g.data.polygons: p.use_smooth = True
        out.append(g)
    return out

def build_exhaust():
    out = []
    for sx in (-1, 1):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=0.05, radius2=0.05, depth=0.16)
        m = make_obj('ExhaustTip', bm, mat_idx=mi('Chrome'))
        m.rotation_euler = (math.radians(90), 0, 0)
        m.location = (sx * 0.42, -2.24, 0.34)
        for p in m.data.polygons: p.use_smooth = True
        out.append(m)
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=0.038, radius2=0.038, depth=0.17)
        m = make_obj('ExhaustInner', bm, mat_idx=mi('BlackPlastic'))
        m.rotation_euler = (math.radians(90), 0, 0)
        m.location = (sx * 0.42, -2.25, 0.34)
        out.append(m)
    return out

def build_interior():
    out = []
    def bx(name, center, size, mat, taper=None, bevel=0.02, levels=1):
        bm = bmesh.new(); box_bm(bm, center, size, taper=taper)
        o = make_obj(name, bm, mat_idx=mi(mat))
        activate(o)
        b = o.modifiers.new('bev', 'BEVEL'); b.width = bevel; b.segments = 3
        if levels > 0:
            s = o.modifiers.new('sub', 'SUBSURF'); s.levels = levels; s.render_levels = levels
        apply_modifiers(o)
        for p in o.data.polygons: p.use_smooth = True
        out.append(o); return o
    bx('Floor', (0, -0.3, 0.32), (1.75, 2.9, 0.04), 'Trim', bevel=0.005, levels=0)
    bx('Dash', (0, 0.70, 0.535), (1.74, 0.36, 0.50), 'Trim', bevel=0.04)
    bx('DashTop', (0, 0.78, 0.785), (1.72, 0.30, 0.035), 'Trim', bevel=0.015)
    bx('Cowl1', (0, 0.98, 0.85), (1.74, 0.24, 0.10), 'Trim', bevel=0.02)
    bx('CowlWall', (0, 0.93, 0.865), (1.74, 0.06, 0.14), 'Trim', bevel=0.01, levels=0)   # closes the cut in the hood; stays below the hood surface
    bx('Console', (0, 0.0, 0.58), (0.28, 1.1, 0.30), 'Interior', bevel=0.04)
    bx('Tunnel', (0, -0.9, 0.5), (0.30, 1.3, 0.16), 'Interior', bevel=0.04)
    for sx in (-1, 1):
        x = sx * 0.36
        bx('SeatBase', (x, -0.10, 0.52), (0.48, 0.52, 0.16), 'Seat', bevel=0.05)
        bx('SeatBack', (x, -0.42, 0.85), (0.46, 0.14, 0.60), 'Seat', bevel=0.05)
        bx('Headrest', (x, -0.45, 1.20), (0.24, 0.10, 0.20), 'Seat', bevel=0.04)
        # door card
        bx('DoorCard', (sx * 0.86, 0.0, 0.68), (0.06, 1.3, 0.55), 'Interior', bevel=0.02, levels=0)
    bx('RearSeat', (0, -1.2, 0.62), (1.4, 0.4, 0.3), 'Seat', bevel=0.05)
    bx('RearShelf', (0, -1.55, 0.98), (1.3, 0.3, 0.05), 'Interior', bevel=0.02, levels=0)
    # (steering wheel + instrument cluster are built at runtime in car.js so they can animate)
    return out

# ----------------------------------------------------------------------------------------------
def render_preview(out_dir, name, loc, target, lens=45, res=(960, 540), samples=40):
    scn = bpy.context.scene
    cam = bpy.data.objects.get('PreviewCam')
    if cam is None:
        cd = bpy.data.cameras.new('PreviewCam')
        cam = bpy.data.objects.new('PreviewCam', cd); link(cam)
    cam.data.lens = lens
    cam.location = loc
    d = Vector(target) - Vector(loc)
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    scn.camera = cam
    scn.render.engine = 'CYCLES'
    scn.cycles.samples = samples
    scn.cycles.device = 'CPU'
    try: scn.cycles.use_denoising = True
    except Exception: pass
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.filepath = os.path.join(out_dir, name + '.png')
    bpy.ops.render.render(write_still=True)

def setup_studio():
    scn = bpy.context.scene
    w = bpy.data.worlds.new('W'); scn.world = w; w.use_nodes = True
    bg = w.node_tree.nodes['Background']
    # sky-ish gradient via sky texture
    nt = w.node_tree
    try:
        sky = nt.nodes.new('ShaderNodeTexSky')
        sky.sky_type = 'NISHITA'; sky.sun_elevation = math.radians(35); sky.sun_rotation = math.radians(200)
        nt.links.new(sky.outputs['Color'], bg.inputs['Color'])
        bg.inputs['Strength'].default_value = 1.0
    except Exception as e:
        bg.inputs['Color'].default_value = (0.55, 0.65, 0.85, 1)
    bpy.ops.mesh.primitive_plane_add(size=80, location=(0, 0, 0))
    g = bpy.context.active_object
    g.data.materials.append(material('Ground', (0.10, 0.11, 0.10, 1), rough=0.9))

def export_glb(path):
    # collect car objects
    keep = [o for o in bpy.data.objects if o.type == 'MESH' and o.name not in ('Plane',) and o.parent is None or (o.parent and o.parent.name == 'Wheel')]
    body_objs = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent is None and o.name != 'Plane']
    wheel_root = bpy.data.objects['Wheel']
    # join body parts per material
    for o in body_objs:
        o.modifiers.clear()
    # interior shells keep their full resolution: decimation turns their window-opening edges into visible saw-teeth
    keepfull = [o for o in body_objs if o.name.startswith(('Headliner', 'Liner'))]
    body_objs = [o for o in body_objs if o not in keepfull]
    activate(body_objs[0])
    for o in body_objs[1:]: o.select_set(True)
    bpy.ops.object.join()
    big = bpy.context.active_object
    big.name = 'CarBody'
    # decimate lightly
    dm = float(arg('--decimate', '0.6'))
    if dm < 1.0:
        m = big.modifiers.new('dec', 'DECIMATE'); m.ratio = dm
        bpy.ops.object.modifier_apply(modifier=m.name)
    if keepfull:
        for o in keepfull: o.modifiers.clear(); o.select_set(True)
        big.select_set(True); activate(big)
        bpy.ops.object.join()
    activate(big)
    bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT'); bpy.ops.mesh.separate(type='MATERIAL'); bpy.ops.object.mode_set(mode='OBJECT')
    # name parts by their (single) material
    parts = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent is None and o.name != 'Plane']
    for o in parts:
        used = sorted(set(p.material_index for p in o.data.polygons))
        if used:
            o.name = 'Part_' + MAT_ORDER[used[0]]
    # wheel parts: single object per material too
    wparts = [o for o in bpy.data.objects if o.type == 'MESH' and o.parent == wheel_root]
    for o in wparts:
        used = sorted(set(p.material_index for p in o.data.polygons))
        o.name = 'W_' + MAT_ORDER[used[0]] + '_' + o.name
    for o in bpy.context.selected_objects: o.select_set(False)
    for o in parts + wparts + [wheel_root]: o.select_set(True)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True, export_yup=True,
                              export_materials='EXPORT', export_cameras=False, export_lights=False, export_extras=False)
    print('EXPORTED', path)

def smooth_boundary(bm, passes=60):
    """Taubin-smooth the open boundary loops of a mesh (removes the stair-stepping left by deleting faces by classification)."""
    bverts = [v for v in bm.verts if any(e.is_boundary for e in v.link_edges)]
    nb = {}
    for v in bverts:
        nb[v] = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
    for i in range(passes):
        lam = 0.5 if i % 2 == 0 else -0.53
        new = {}
        for v in bverts:
            n = nb[v]
            if len(n) != 2: new[v] = v.co.copy(); continue
            avg = (n[0].co + n[1].co) * 0.5
            new[v] = v.co + (avg - v.co) * lam
        for v, p in new.items(): v.co = p

def build_headliner(cabin):
    """Inner shell of the greenhouse so the cabin has a roof/pillar lining (visible from the cockpit and through the glass)."""
    d = cabin.copy(); d.data = cabin.data.copy(); d.name = 'Headliner'; link(d)
    bm = bmesh.new(); bm.from_mesh(d.data)
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index == mi('Glass')], context='FACES')   # keep the windows open
    bm.faces.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if face_center(f).z < 0.93 and abs(f.normal.z) > 0.85], context='FACES')   # drop the flat cabin bottom (it would be a table at waist height)
    front_roof = [f for f in bm.faces if face_center(f).y > 0.10 and face_center(f).z > 1.02]
    bmesh.ops.delete(bm, geom=front_roof, context='FACES')   # front roof panel: the driver looks out through here
    bm.faces.ensure_lookup_table()
    smooth_boundary(bm, 260)
    c = Vector((0, -0.35, 1.08))
    for v in bm.verts:
        o = v.co - c
        v.co = c + Vector((o.x * 0.955, o.y * 0.985, o.z * 0.90))
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    for f in bm.faces:
        f.material_index = mi('Headliner'); f.smooth = True
    bm.to_mesh(d.data); bm.free()
    return d

def build_roof_lining():
    """Solid ceiling over the cabin with a clean, gently arched front header (the cabin shell alone leaves the roof open from inside)."""
    bm = bmesh.new()
    nx, ny = 28, 64
    cols = []
    for j in range(nx + 1):
        u = -1 + 2 * j / nx
        yf = 0.17 - 0.10 * u * u                                   # arched leading edge
        col = []
        for i in range(ny + 1):
            y = -1.62 + (yf + 1.62) * (i / ny)
            zt = interp(ROOF, y); w = interp(WT, y) + 0.03
            col.append(bm.verts.new((u * w, y, zt - 0.048 - 0.05 * u * u - 0.05 * u ** 6)))
        cols.append(col)
    for j in range(nx):
        for i in range(ny):
            f = bm.faces.new((cols[j][i + 1], cols[j + 1][i + 1], cols[j + 1][i], cols[j][i]))
            f.material_index = mi('Headliner'); f.smooth = True
    return make_obj('HeadlinerRoof', bm, mat_idx=mi('Headliner'))

def build_pillars():
    """Clean A-pillar trims (the cabin shell's own pillars come out jagged where the windshield glass was cut away)."""
    out = []
    for sx in (-1, 1):
        rail = [Vector((sx * (interp(WT, yy) + 0.008), yy, interp(ROOF, yy) - 0.150)) for yy in (-1.45, -1.2, -0.95, -0.7, -0.45, -0.2, 0.0)]   # roof-rail trim along the lining edge: the pillar has no visible end
        path = rail + [Vector((sx * 0.680, 0.07, 1.158)), Vector((sx * 0.690, 0.40, 1.095)), Vector((sx * 0.715, 0.76, 1.030)), Vector((sx * 0.735, 0.975, 0.985))]
        # smooth the polyline into a dense curve
        pts = []
        for k in range(len(path) - 1):
            for t in range(12):
                pts.append(path[k].lerp(path[k + 1], t / 12))
        pts.append(path[-1])
        bm = bmesh.new()
        seg = 12
        rings = []
        for idx, p in enumerate(pts):
            tng = (pts[min(idx + 1, len(pts) - 1)] - pts[max(idx - 1, 0)]).normalized()
            aa = tng.cross(Vector((0, 0, 1))).normalized()
            bb = aa.cross(tng).normalized()
            if bb.z < 0: bb = -bb
            ring = []
            k = min(1.0, 0.45 + idx / 10.0) * min(1.0, 0.5 + (len(pts) - 1 - idx) / 6.0)   # tuck the ends into the roof / dash
            for s_ in range(seg):
                ang = 2 * math.pi * s_ / seg
                ring.append(bm.verts.new(p + aa * (0.034 * k * math.cos(ang)) + bb * (0.022 * k * math.sin(ang))))
            rings.append(ring)
        for i in range(len(rings) - 1):
            for s_ in range(seg):
                f = bm.faces.new((rings[i][s_], rings[i][(s_ + 1) % seg], rings[i + 1][(s_ + 1) % seg], rings[i + 1][s_]))
                f.material_index = mi('BlackPlastic'); f.smooth = True
        for cap in (rings[0], list(reversed(rings[-1]))):
            f = bm.faces.new(cap); f.material_index = mi('BlackPlastic')
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        out.append(make_obj('HeadlinerPillar', bm, mat_idx=mi('BlackPlastic')))
    return out

def build_liners(body):
    """Inner side walls of the cabin (reversed copy of the body sides, pushed inwards) so the doors/sills are not see-through from the driver's seat."""
    d = body.copy(); d.data = body.data.copy(); d.name = 'Liner'; link(d)
    bm = bmesh.new(); bm.from_mesh(d.data)
    bm.faces.ensure_lookup_table()
    keep = []
    for f in bm.faces:
        c = face_center(f)
        if abs(c.x) > 0.45 and abs(f.normal.x) > 0.45 and (f.normal.x * c.x) > 0 and -1.75 < c.y < 1.0 and 0.2 < c.z < 1.1:
            keep.append(f)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f not in set(keep)], context='FACES')
    for v in bm.verts:
        v.co.x -= math.copysign(0.04, v.co.x)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    for f in bm.faces:
        f.material_index = mi('Interior'); f.smooth = True
    bm.to_mesh(d.data); bm.free()
    return d

def main():
    reset()
    make_materials()
    body = build_body()
    cabin = build_cabin()
    subsurf_apply(body, 3)
    subsurf_apply(cabin, 3)
    smooth_shade(body); smooth_shade(cabin)
    cabin_glass(cabin)
    body_pass(body)
    smooth_shade(body); smooth_shade(cabin)
    headliner = build_headliner(cabin)
    liners = build_liners(body)
    roof = build_roof_lining()
    pillars = build_pillars()
    details = build_details(body, cabin)
    mirrors = build_mirrors()
    exhaust = build_exhaust()
    interior = build_interior()
    wheel_root, wheel_parts = build_wheel()
    out = arg('--preview')
    glb = arg('--glb')
    if out:
        os.makedirs(out, exist_ok=True)
        place_wheels_preview(wheel_root, wheel_parts)
        setup_studio()
        render_preview(out, 'side', (9.0, 0.0, 1.0), (0, 0, 0.65), lens=50)
        render_preview(out, 'rear34', (-5.2, -5.6, 2.0), (0, 0, 0.7), lens=42)
        render_preview(out, 'front34', (5.2, 5.6, 1.7), (0, 0, 0.65), lens=42)
        render_preview(out, 'chase', (0.0, -6.6, 2.2), (0, 0, 0.9), lens=50)
        render_preview(out, 'top', (0.0, -0.01, 9), (0, 0, 0.9), lens=40)
        render_preview(out, 'wheel', (2.6, 1.9, 0.6), (0.8, 1.37, 0.33), lens=60)
    if glb:
        export_glb(glb)

main()
