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
    tyre = revolve(prof, 120, mat='Rubber', name='Tire')
    # sidewall lettering-ish relief omitted; smooth shade
    for p in tyre.data.polygons: p.use_smooth = True
    parts.append(tyre)
    # ---- rim barrel ----
    rp = [(-0.098, 0.232), (-0.098, 0.222), (-0.09, 0.212), (-0.02, 0.208), (0.05, 0.208), (0.095, 0.216), (0.108, 0.229), (0.112, 0.233), (0.108, 0.236), (0.098, 0.2325)]
    barrel = revolve(rp, 96, mat='RimAlloy', name='RimBarrel')
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
    hub = revolve([(a + 0.02, r) for a, r in hp], 48, mat='RimAlloy', name='RimHub')
    for p in hub.data.polygons: p.use_smooth = True
    parts.append(hub)
    # inner dark disc behind spokes (rim well)
    inner = revolve([(-0.02, 0.05), (-0.02, 0.21), (0.0, 0.21), (0.0, 0.05)], 64, mat='BrakeDisc', name='InnerDisc')
    parts.append(inner)
    # ---- brake disc ----
    disc = revolve([(-0.055, 0.075), (-0.055, 0.16), (-0.03, 0.166), (-0.03, 0.075), (-0.055, 0.075)], 96, mat='BrakeDisc', name='Disc')
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

def decal(name, poly, plane, fixed, shell, mat, offset=0.0025, res=0.006, axis=None, thickness=0.0):
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
    tl = [(-0.86, 0.93), (-0.62, 0.945), (-0.30, 0.935), (-0.08, 0.915), (-0.08, 0.885), (-0.30, 0.895), (-0.62, 0.895), (-0.86, 0.885)]
    objs.append(decal('TailL_bg', [(a * 1.0, b) for a, b in tl], 'XZ', tail_y, shell, 'Trim', offset=0.0015))
    tl_in = [(-0.845, 0.925), (-0.62, 0.938), (-0.31, 0.928), (-0.10, 0.910), (-0.10, 0.890), (-0.31, 0.900), (-0.62, 0.900), (-0.845, 0.892)]
    objs.append(decal('TailL', tl_in, 'XZ', tail_y, shell, 'TailLamp', offset=0.0035))
    objs.append(decal('TailR_bg', mirror_x(tl), 'XZ', tail_y, shell, 'Trim', offset=0.0015))
    objs.append(decal('TailR', mirror_x(tl_in), 'XZ', tail_y, shell, 'TailLamp', offset=0.0035))
    # centre strip
    strip = [(-0.10, 0.905), (0.10, 0.905), (0.10, 0.892), (-0.10, 0.892)]
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
    grille = [(-0.55, 0.50), (-0.38, 0.52), (0.38, 0.52), (0.55, 0.50), (0.60, 0.36), (0.40, 0.30), (-0.40, 0.30), (-0.60, 0.36)]
    objs.append(decal('Grille', grille, 'XZ', front_y, shell, 'BlackPlastic', offset=0.003))
    # lower intakes
    for sx in (-1, 1):
        it = [(sx * 0.66, 0.36), (sx * 0.84, 0.40), (sx * 0.84, 0.26), (sx * 0.66, 0.24)]
        objs.append(decal('Intake', it, 'XZ', front_y, shell, 'BlackPlastic', offset=0.003))
    # headlights (side patches wrapped from front)
    for sx in (-1, 1):
        hl = [(sx * 0.80, 0.68), (sx * 0.55, 0.715), (sx * 0.30, 0.70), (sx * 0.30, 0.65), (sx * 0.55, 0.64), (sx * 0.80, 0.62)]
        objs.append(decal('HeadBg', hl, 'XZ', front_y, shell, 'Trim', offset=0.0015))
        hl_in = [(sx * 0.785, 0.672), (sx * 0.55, 0.705), (sx * 0.34, 0.693), (sx * 0.34, 0.658), (sx * 0.55, 0.648), (sx * 0.785, 0.628)]
        objs.append(decal('HeadLens', hl_in, 'XZ', front_y, shell, 'HeadLens', offset=0.0035))
        drl = [(sx * 0.74, 0.664), (sx * 0.46, 0.688), (sx * 0.46, 0.672), (sx * 0.74, 0.65)]
        objs.append(decal('HeadLamp', drl, 'XZ', front_y, shell, 'HeadLamp', offset=0.0055))
    # ---------------- panel lines ----------------
    for sx in (-1, 1):
        X = sx * 1.4
        # door front & rear vertical lines (side view; projected along X)
        curve_line('DoorFront', [(X, 0.55, 0.24), (X, 0.56, 0.60), (X, 0.50, 0.92), (X, 0.34, 1.04), (X, 0.14, 1.25)], shell, axis='x')
        curve_line('DoorRear', [(X, -0.72, 0.22), (X, -0.72, 0.60), (X, -0.72, 0.95), (X, -0.70, 1.05)], shell, axis='x')
        curve_line('DoorSill', [(X, 0.55, 0.25), (X, -0.72, 0.25)], shell, axis='x')
        # hood side lines (projected along Z)
        Z = 1.6
        curve_line('HoodLine', [(sx * 0.80, 0.9, Z), (sx * 0.80, 1.5, Z), (sx * 0.62, 2.0, Z), (sx * 0.5, 2.2, Z)], shell, axis='z', width=0.004)
    curve_line('HoodCowl', [(-0.82, 0.92, 1.6), (0.0, 0.94, 1.6), (0.82, 0.92, 1.6)], shell, axis='z', width=0.004)
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
        box_bm(bm, (0, 0, 0), (0.10, 0.045, 0.03))
        s = make_obj('MirrorStalk', bm, mat_idx=mi('BlackPlastic'))
        s.location = (sx * 0.90, 0.53, 1.0)
        out.append(s)
        # mirror glass
        bm = bmesh.new()
        box_bm(bm, (0, 0, 0), (0.001, 0.10, 0.075))
        g = make_obj('MirrorGlass', bm, mat_idx=mi('Chrome'))
        g.location = (sx * 1.0, 0.47, 1.03)
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
        s = o.modifiers.new('sub', 'SUBSURF'); s.levels = levels; s.render_levels = levels
        apply_modifiers(o)
        for p in o.data.polygons: p.use_smooth = True
        out.append(o); return o
    bx('Floor', (0, -0.3, 0.32), (1.6, 2.9, 0.04), 'Interior', bevel=0.005, levels=0)
    bx('Dash', (0, 0.70, 0.92), (1.55, 0.36, 0.16), 'Interior', bevel=0.05)
    bx('DashTop', (0, 0.80, 0.995), (1.5, 0.30, 0.05), 'Trim', bevel=0.02)
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
    # steering wheel
    bpy.ops.mesh.primitive_torus_add(major_radius=0.17, minor_radius=0.017, major_segments=48, minor_segments=12, location=(-0.36, 0.52, 1.0), rotation=(math.radians(-68), 0, 0))
    sw = bpy.context.active_object; sw.name = 'SteeringWheel'
    set_all_mats(sw.data)
    for p in sw.data.polygons: p.material_index = mi('BlackPlastic'); p.use_smooth = True
    out.append(sw)
    return out
