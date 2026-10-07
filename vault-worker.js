/* Vault HD renderer — runs in a Web Worker.
   Each metal part is described as a height map, then lit per pixel at full
   device resolution: reflections of a studio environment (softbox + strip
   light), Kajiya-Kay highlights for brushed steel, cavity occlusion and soft
   contact shadows. Coordinates are screen space: x right, y down, z toward
   the viewer. */
'use strict';

function norm(x, y, z) { var l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
var L = norm(-0.42, -0.62, 0.66);          // key light (top-left, in front)
var SOFT = norm(-0.45, -0.75, 0.5);        // big softbox seen in reflections
var STRIP = norm(0.8, -0.15, 0.58);        // narrow strip light on the right
var LXY = Math.hypot(L[0], L[1]);
var SHX = -L[0] / LXY, SHY = -L[1] / LXY;  // direction shadows fall in

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function smooth(a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
function hash(n) {
    n |= 0;
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
}
function hash2(x, y) { return hash(Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663)); }
function vnoise(x, y) {
    var xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
    var s = 0, a = 0.5, f = 1;
    for (var i = 0; i < 4; i++) { s += a * vnoise(x * f, y * f); f *= 2.03; a *= 0.5; }
    return s;
}

// Separable running-sum box blur, repeated to approximate a gaussian
function blur(src, w, h, r, passes) {
    var a = Float32Array.from(src), b = new Float32Array(w * h), x, y, sum, row, n;
    r = Math.max(1, Math.round(r)); n = 2 * r + 1;
    for (var p = 0; p < passes; p++) {
        for (y = 0; y < h; y++) {
            row = y * w; sum = 0;
            for (x = -r; x <= r; x++) sum += a[row + clamp(x, 0, w - 1)];
            for (x = 0; x < w; x++) {
                b[row + x] = sum / n;
                sum += a[row + Math.min(x + r + 1, w - 1)] - a[row + Math.max(x - r, 0)];
            }
        }
        for (x = 0; x < w; x++) {
            sum = 0;
            for (y = -r; y <= r; y++) sum += b[clamp(y, 0, h - 1) * w + x];
            for (y = 0; y < h; y++) {
                a[y * w + x] = sum / n;
                sum += b[Math.min(y + r + 1, h - 1) * w + x] - b[Math.max(y - r, 0) * w + x];
            }
        }
    }
    return a;
}

// Fine scratches rasterised into a mask
function scratches(w, h, seed, count, maxLen) {
    var m = new Float32Array(w * h);
    for (var k = 0; k < count; k++) {
        var x0 = hash(seed * 31 + k * 7) * w, y0 = hash(seed * 17 + k * 11 + 3) * h;
        var a = hash(k * 13 + seed) * Math.PI, len = (0.15 + 0.85 * hash(k * 5 + seed + 1)) * maxLen;
        var inten = 0.3 + 0.7 * hash(k * 3 + seed + 2), dx = Math.cos(a), dy = Math.sin(a);
        for (var s = 0; s < len; s += 0.5) {
            var x = (x0 + dx * s) | 0, y = (y0 + dy * s) | 0;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            var i = y * w + x, v = inten * (0.55 + 0.45 * Math.sin(s * 0.21 + k));
            if (v > m[i]) m[i] = v;
        }
    }
    return m;
}

var E = [0, 0, 0], C = [0, 0, 0];

// Studio environment seen in reflections
function env(rx, ry, rz, rough) {
    // room: brighter towards the ceiling, a dark floor below a horizon that sits a
    // little under the viewing direction (gives chrome its tell-tale mirrored edge)
    var v = -ry, hzn = -0.35, soft = 0.03 + rough * 0.25;
    var sky = 0.05 + 0.17 * clamp((v - hzn) / 1.35, 0, 1);
    var base = 0.006 + (sky - 0.006) * smooth(hzn - soft, hzn + soft, v);
    var w = rough * 0.28;
    var s1 = smooth(0.84 - w, 0.965 - w * 0.4, rx * SOFT[0] + ry * SOFT[1] + rz * SOFT[2]) * (2.4 - rough * 1.3);
    var s2 = smooth(0.94 - w, 0.992 - w * 0.4, rx * STRIP[0] + ry * STRIP[1] + rz * STRIP[2]) * (1.0 - rough * 0.45);
    var bounce = Math.max(0, ry) * 0.06;
    E[0] = base + s1 + s2 * 0.85 + bounce * 1.3;
    E[1] = base + s1 * 0.97 + s2 * 0.92 + bounce;
    E[2] = base + s1 * 0.9 + s2 + bounce * 0.6;
}

// Light one metal pixel (normal n, albedo a, brush tangent t) into C
function shade(nx, ny, nz, ar, ag, ab, rough, tx, ty, aniso, light) {
    env(2 * nz * nx, 2 * nz * ny, 2 * nz * nz - 1, rough);
    var ndl = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
    var spec = 0;
    if (aniso > 0) {
        var hx = L[0], hy = L[1], hz = L[2] + 1, hl = Math.hypot(hx, hy, hz);
        var th = (tx * hx + ty * hy) / hl;
        spec = Math.pow(Math.max(0, 1 - th * th), 30) * aniso * ndl;
    }
    var dif = ndl * 0.16 + 0.02;
    C[0] = (ar * (E[0] + dif) + spec * (0.35 + ar)) * light;
    C[1] = (ag * (E[1] + dif) + spec * (0.35 + ag)) * light;
    C[2] = (ab * (E[2] + dif) + spec * (0.35 + ab)) * light;
}

// Exposure, gamma, then a gentle S-curve so mirrored darks stay deep (photographic contrast)
function tone(c) {
    c = Math.pow(1 - Math.exp(-c * 1.6), 1 / 2.2);
    return (c + (c * c * (3 - 2 * c) - c) * 0.55) * 255;
}

function writePx(out, i, alpha) {
    var o = i * 4;
    out[o] = tone(C[0]); out[o + 1] = tone(C[1]); out[o + 2] = tone(C[2]); out[o + 3] = alpha * 255;
}

// Composite a lit pixel of coverage `cov` over a soft shadow of strength `sh`
function writeOverShadow(out, i, cov, sh) {
    var o = i * 4, a = cov + sh * (1 - cov);
    if (a <= 0) { out[o + 3] = 0; return; }
    var k = cov / a;
    out[o] = tone(C[0]) * k; out[o + 1] = tone(C[1]) * k; out[o + 2] = tone(C[2]) * k; out[o + 3] = a * 255;
}

// Materials: albedo (linear), roughness, anisotropy
var MAT = [
    /* 0 steel  */ [0.52, 0.53, 0.54, 0.35, 0.9],
    /* 1 brass  */ [0.70, 0.48, 0.20, 0.30, 0.7],
    /* 2 rivet  */ [0.62, 0.63, 0.64, 0.14, 0.0],
    /* 3 gap    */ [0.05, 0.05, 0.05, 0.60, 0.0],
    /* 4 chrome */ [0.68, 0.69, 0.70, 0.12, 0.55],
    /* 5 strap  */ [0.40, 0.41, 0.42, 0.40, 0.8]
];
var T_CIRC = 0, T_VERT = 1, T_HORZ = 2, T_NONE = 3;

/* ------------------------------------------------------------------ door */

// Hinge barrels plus the straps bolted onto the door face
var HG = { h: 0, cov: 0, mat: 0, tan: 0 };
function hinge(X, Y, u) {
    HG.cov = 0; HG.h = -1;
    for (var k = 0; k < 2; k++) {
        var y0 = k ? 0.28 : -0.6, y1 = y0 + 0.32, cx = -1.01, hw = 0.08, q, h, cov, e;
        // strap
        if (X > cx && X < -0.74 && Y > y0 + 0.07 && Y < y1 - 0.07) {
            e = Math.min(X - cx, -0.74 - X, Y - y0 - 0.07, y1 - 0.07 - Y);
            h = 0.016 + 0.006 * smooth(0, 0.012, e);
            var bx = -0.8, by = Math.abs(Y - (y0 + 0.11)) < Math.abs(Y - (y1 - 0.11)) ? y0 + 0.11 : y1 - 0.11;
            var bd = Math.hypot(X - bx, Y - by), mat = 5, tan = T_HORZ;
            if (bd < 0.024) { h += 0.012 * Math.sqrt(1 - (bd / 0.024) * (bd / 0.024)); mat = 2; tan = T_NONE; }
            cov = clamp(e * u + 0.5, 0, 1);
            if (h > HG.h) { HG.h = h; HG.cov = cov; HG.mat = mat; HG.tan = tan; }
        }
        // barrel
        if (X > cx - hw && X < cx + hw && Y > y0 && Y < y1) {
            q = (X - cx) / hw;
            h = 0.03 + 0.055 * Math.sqrt(Math.max(0, 1 - q * q));
            var gy = (Y - y0) / 0.32, mat2 = 4;
            if (Math.abs(gy - 1 / 3) < 0.012 || Math.abs(gy - 2 / 3) < 0.012) { h -= 0.012; mat2 = 3; }
            cov = clamp(Math.min(X - cx + hw, cx + hw - X, Y - y0, y1 - Y) * u + 0.5, 0, 1);
            if (h > HG.h) { HG.h = h; HG.cov = cov; HG.mat = mat2; HG.tan = T_VERT; }
        }
        // end caps
        var cw = hw + 0.013;
        for (var j = 0; j < 2; j++) {
            var ca = j ? y1 - 0.026 : y0 - 0.013, cb = ca + 0.039;
            if (X > cx - cw && X < cx + cw && Y > ca && Y < cb) {
                q = (X - cx) / cw;
                e = Math.min(Y - ca, cb - Y);
                h = (0.034 + 0.062 * Math.sqrt(Math.max(0, 1 - q * q))) * (0.75 + 0.25 * smooth(0, 0.008, e));
                cov = clamp(Math.min(X - cx + cw, cx + cw - X, e) * u + 0.5, 0, 1);
                if (h > HG.h) { HG.h = h; HG.cov = cov; HG.mat = 4; HG.tan = T_VERT; }
            }
        }
    }
}

function renderDoor(t) {
    var S = t.size, u = t.u, c = S / 2, seed = t.seed, mask = t.mask ? new Uint8Array(t.mask) : null;
    var N = S * S, H = new Float32Array(N), A = new Float32Array(N), M = new Uint8Array(N), T = new Uint8Array(N), ENG = new Float32Array(N);
    var step = Math.PI * 2 / 24, x, y, i;
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
        i = y * S + x;
        var X = (x + 0.5 - c) / u, Y = (y + 0.5 - c) / u, r = Math.hypot(X, Y);
        var cov = clamp((1 - r) * u + 0.5, 0, 1), h = 0, mat = 0, tan = T_CIRC;
        h += 0.012 * smooth(0.895, 0.905, r);                           // raised outer rim
        if (r > 0.965) { var q = (r - 0.965) / 0.035; h -= 0.04 * q * q; } // rolled outer edge
        if (r > 0.925 && r < 0.942) { mat = 1; h -= 0.004 * smooth(0.925, 0.929, r) * (1 - smooth(0.938, 0.942, r)); }
        h -= 0.009 * Math.max(0, 1 - Math.abs(r - 0.78) / 0.009);      // V groove
        h += 0.002 * Math.max(0, 1 - Math.abs(r - 0.797) / 0.003);     // fine ridge
        h += 0.022 * (1 - smooth(0.546, 0.564, r));                    // centre plate
        if (r >= 0.564 && r < 0.59) {
            if (r < 0.569) mat = 3;
            else { mat = 1; h += 0.006 * Math.sin(Math.PI * (r - 0.569) / 0.021); }
        }
        var k = Math.round(Math.atan2(X, -Y) / step), ra = k * step;
        var dd = Math.hypot(X - Math.sin(ra) * 0.86, Y + Math.cos(ra) * 0.86);
        if (dd < 0.022) { var qq = dd / 0.022; h += 0.013 * Math.sqrt(1 - qq * qq); mat = 2; tan = T_NONE; }
        if (mask) { var e = mask[i] / 255; if (e > 0) { h -= 0.007 * e; ENG[i] = e; } }
        if (r > 1) h = -0.03 - (r - 1) * 0.6;
        hinge(X, Y, u);
        if (HG.cov > 0 && HG.h > h) { h = HG.h; mat = HG.mat; tan = HG.tan; cov = Math.max(cov, HG.cov); ENG[i] = 0; }
        H[i] = h * u; A[i] = cov; M[i] = mat; T[i] = tan;
    }

    var Hb = blur(H, S, S, 0.012 * u, 2);           // for cavity occlusion
    var Hs = blur(H, S, S, 0.007 * u, 2);           // for contact shadows
    var scr = scratches(S, S, seed, 90, u * 0.22);
    var shOff = 0.014 * u, out = new Uint8ClampedArray(N * 4);

    for (y = 1; y < S - 1; y++) for (x = 1; x < S - 1; x++) {
        i = y * S + x;
        if (A[i] <= 0) continue;
        var X2 = (x + 0.5 - c) / u, Y2 = (y + 0.5 - c) / u, r2 = Math.hypot(X2, Y2) || 1e-6;
        var nx = -(H[i + 1] - H[i - 1]) * 0.5, ny = -(H[i + S] - H[i - S]) * 0.5, nz = 1;
        var m = MAT[M[i]], ar = m[0], ag = m[1], ab = m[2], rough = m[3], aniso = m[4], tx = 0, ty = 0;
        var tm = T[i], line, bv = 0;
        if (tm === T_CIRC) {
            tx = -Y2 / r2; ty = X2 / r2;
            line = Math.round(r2 * u * 1.5);
            var tilt = (hash(line * 13 + seed) - 0.5) * 0.06;
            nx += tilt * X2 / r2; ny += tilt * Y2 / r2;
            bv = (hash(line * 7 + seed) - 0.5) * 0.16 + (vnoise(Math.atan2(Y2, X2) * u * 0.05, line * 0.37) - 0.5) * 0.12;
        } else if (tm === T_VERT || tm === T_HORZ) {
            if (tm === T_VERT) { ty = 1; line = x; } else { tx = 1; line = y; }
            bv = (hash(line * 7 + seed) - 0.5) * 0.14;
            var tl = (hash(line * 13 + seed) - 0.5) * 0.05;
            if (tm === T_VERT) nx += tl; else ny += tl;
        }
        var nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;

        // grime, smudges, scratches, dirt in engraved cuts
        var g = fbm(X2 * 2.6 + seed % 97, Y2 * 2.6), dirt = 0.18 * smooth(0.45, 0.8, g) + 0.1 * smooth(0.2, 1.1, Y2);
        var sc = scr[i] * (tm === T_NONE ? 0.3 : 1), eg = ENG[i];
        var albK = (1 + bv) * (1 - dirt) * (1 - 0.6 * eg) + sc * 0.12;
        ar *= albK; ag *= albK; ab *= albK;
        rough = clamp(rough + dirt * 0.4 + eg * 0.4, 0, 1);
        aniso *= (1 - sc * 0.6) * (1 - eg);

        var cav = clamp((Hb[i] - H[i]) / (0.006 * u), 0, 1);
        var sx = clamp(Math.round(x - SHX * shOff), 0, S - 1), sy = clamp(Math.round(y - SHY * shOff), 0, S - 1);
        var sh = clamp((Hs[sy * S + sx] - H[i] - 0.002 * u) / (0.012 * u), 0, 1);
        shade(nx, ny, nz, ar, ag, ab, rough, tx, ty, aniso, (1 - 0.6 * cav) * (1 - 0.55 * sh));
        writePx(out, i, A[i]);
    }
    return [{ w: S, h: S, data: out.buffer }];
}

/* ----------------------------------------------------------------- frame */

function renderFrame(t) {
    var R = t.R, sc = t.scale, S = t.size, c = S / 2, seed = t.seed + 7;
    var N = S * S, H = new Float32Array(N), A = new Float32Array(N), RV = new Uint8Array(N), x, y, i;
    var step = Math.PI * 2 / 20, off = Math.PI / 20;
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
        i = y * S + x;
        var dx = x + 0.5 - c, dy = y + 0.5 - c, r = Math.hypot(dx, dy), tt = (r - R) / sc, h;
        A[i] = clamp(Math.min(r - (R + 2.5 * sc), R + 50 * sc - r) + 0.5, 0, 1);
        if (tt < 3) h = 0;
        else if (tt < 8) h = 10 * Math.sin((tt - 3) / 5 * Math.PI / 2);
        else if (tt < 28) h = 10 - (tt - 8) * 0.2;
        else if (tt < 30.5) h = 6 - 2 * Math.sin((tt - 28) / 2.5 * Math.PI);
        else if (tt < 44) h = 6 + 3 * smooth(30.5, 44, tt);
        else if (tt < 50) h = 9 * Math.cos((tt - 44) / 6 * Math.PI / 2);
        else h = -(tt - 50) * 2;
        var k = Math.round((Math.atan2(dx, -dy) - off) / step), ra = k * step + off, rr = R + 36 * sc;
        var dd = Math.hypot(dx - Math.sin(ra) * rr, dy + Math.cos(ra) * rr) / sc;
        if (dd < 5.5) { h += 4 * Math.sqrt(1 - (dd / 5.5) * (dd / 5.5)); RV[i] = 1; }
        H[i] = h * sc;
    }
    var Hb = blur(H, S, S, 4 * sc, 2), scr = scratches(S, S, seed, 70, 40 * sc), out = new Uint8ClampedArray(N * 4);
    for (y = 1; y < S - 1; y++) for (x = 1; x < S - 1; x++) {
        i = y * S + x;
        if (A[i] <= 0) continue;
        var X = x + 0.5 - c, Y = y + 0.5 - c, r2 = Math.hypot(X, Y);
        var nx = -(H[i + 1] - H[i - 1]) * 0.5, ny = -(H[i + S] - H[i - S]) * 0.5, nz = 1, tx = -Y / r2, ty = X / r2;
        var line = Math.round(r2 * 1.5), bv = 0, rough = 0.42, aniso = 0.8, ar = 0.46, ag = 0.47, ab = 0.48;
        if (RV[i]) { rough = 0.16; aniso = 0; ar = 0.6; ag = 0.61; ab = 0.62; }
        else {
            var tilt = (hash(line * 13 + seed) - 0.5) * 0.06;
            nx += tilt * X / r2; ny += tilt * Y / r2;
            bv = (hash(line * 7 + seed) - 0.5) * 0.16 + (vnoise(Math.atan2(Y, X) * r2 * 0.05, line * 0.37) - 0.5) * 0.12;
        }
        var nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
        var g = fbm(X / R * 2.4 + 11, Y / R * 2.4), dirt = 0.22 * smooth(0.42, 0.8, g) + 0.12 * smooth(-0.2, 1.2, Y / R);
        var k2 = (1 + bv) * (1 - dirt) + scr[i] * 0.1;
        var cav = clamp((Hb[i] - H[i]) / (3 * sc), 0, 1);
        shade(nx, ny, nz, ar * k2, ag * k2, ab * k2, rough + dirt * 0.4, tx, ty, aniso * (1 - scr[i] * 0.6), 1 - 0.6 * cav);
        writePx(out, i, A[i]);
    }
    return [{ w: S, h: S, data: out.buffer }];
}

/* ------------------------------------------------------------------ wall */

function renderWall(t) {
    var W = t.w, Hh = t.h, sc = t.scale, cx = W / 2, cy = Hh / 2, seed = t.seed + 3;
    var out = new Uint8ClampedArray(W * Hh * 4), x, y, i, N = W * Hh;
    var HW = new Float32Array(N), PID = new Int32Array(N), DS = new Float32Array(N), RE = new Uint8Array(N);
    for (y = 0; y < Hh; y++) for (x = 0; x < W; x++) {
        i = y * W + x;
        HW[i] = wallH((x - cx) / sc + 120, (y - cy) / sc + 90, seed) * sc;
        PID[i] = WH.pid; DS[i] = WH.ds; RE[i] = WH.rivetEdge ? 1 : 0;
    }
    var sig = 0.42 * Math.max(W, Hh);
    for (y = 1; y < Hh - 1; y++) for (x = 1; x < W - 1; x++) {
        i = y * W + x;
        var px = (x - cx) / sc + 120, py = (y - cy) / sc + 90;
        var nx = -(HW[i + 1] - HW[i - 1]) * 0.5, ny = -(HW[i + W] - HW[i - W]) * 0.5, nz = 1, nl = Math.hypot(nx, ny, nz);
        var pid = PID[i], ds = DS[i];
        var tone0 = 0.8 + 0.4 * hash(pid + seed);
        var g = fbm(px * 0.012 + pid, py * 0.012), streak = vnoise(px * 0.06, py * 0.004 + pid);
        var rust = smooth(0.5, 0.85, g);
        var ar = (0.075 + rust * 0.03) * tone0 * (1 - 0.35 * smooth(0.55, 0.9, streak));
        var ag = (0.07 + rust * 0.012) * tone0 * (1 - 0.35 * smooth(0.55, 0.9, streak));
        var ab = (0.066 - rust * 0.01) * tone0 * (1 - 0.35 * smooth(0.55, 0.9, streak));
        var brush = (hash(Math.round(py * 2) * 7 + pid) - 0.5) * 0.15;
        ar *= 1 + brush; ag *= 1 + brush; ab *= 1 + brush;
        var ao = 1 - 0.55 * (1 - smooth(0, 3.5, ds)) - (RE[i] ? 0.3 : 0);
        var ddx = x - cx, ddy = (y - cy) * 1.1 + 0.08 * Hh;
        var spot = 0.14 + 1.15 * Math.exp(-(ddx * ddx + ddy * ddy) / (2 * sig * sig));
        shade(nx / nl, ny / nl, nz / nl, ar, ag, ab, 0.5 + rust * 0.3, 1, 0, 0.45, ao * spot);
        writePx(out, i, 1);
    }
    return [{ w: W, h: Hh, data: out.buffer }];
}

var WH = { pid: 0, ds: 0, rivetEdge: false };
function wallH(px, py, seed) {
    var fx = Math.floor(px / 240), fy = Math.floor(py / 180), lx = px - fx * 240, ly = py - fy * 180;
    var pid = fx * 131 + fy * 71, ds = Math.min(lx, 240 - lx, ly, 180 - ly), h = 0;
    h -= 1.6 * (1 - smooth(0, 4, ds));
    if (ds < 1.2) h -= 2;
    h += (hash(pid + seed) - 0.5) * 0.012 * (lx - 120) + (hash(pid + seed + 1) - 0.5) * 0.012 * (ly - 90);
    h += (vnoise(px * 0.05, py * 0.05) - 0.5) * 0.25;
    var rivetEdge = false, rx, ry, d;
    // rivets along vertical seams
    rx = lx < 120 ? 9 : 231; ry = Math.round((ly - 15) / 30) * 30 + 15;
    d = Math.hypot(lx - rx, ly - ry);
    if (d < 3.3) h += 2.3 * Math.sqrt(1 - (d / 3.3) * (d / 3.3)); else if (d < 4.5) rivetEdge = true;
    // rivets along horizontal seams
    ry = ly < 90 ? 9 : 171; rx = Math.round((lx - 15) / 30) * 30 + 15;
    d = Math.hypot(lx - rx, ly - ry);
    if (d < 3.3) h += 2.3 * Math.sqrt(1 - (d / 3.3) * (d / 3.3)); else if (d < 4.5) rivetEdge = true;
    WH.pid = pid; WH.ds = ds; WH.rivetEdge = rivetEdge;
    return h;
}

/* ----------------------------------------------------------------- wheel */

// Chrome handwheel: three bars through the centre with ball knobs, plus hub.
// Rendered at several angles so the reflections stay put while it turns.
function renderWheel(t) {
    var B = t.box, Cs = Math.round(B * 1.24), c = Cs / 2, k = B, frames = [];
    var N = Cs * Cs, rb = 0.0375 * k, rk = 0.0828 * k, kx = 0.432 * k, half = 0.46 * k, rh = 0.23 * k;
    var shOff = 0.07 * k;
    for (var f = 0; f < t.frames; f++) {
        var a = f * t.step * Math.PI / 180, H = new Float32Array(N), A = new Float32Array(N), x, y, i;
        var CA = [], SA = [];
        for (var jj = 0; jj < 3; jj++) { CA.push(Math.cos(a + jj * Math.PI / 3)); SA.push(Math.sin(a + jj * Math.PI / 3)); }
        for (y = 0; y < Cs; y++) for (x = 0; x < Cs; x++) {
            i = y * Cs + x;
            var X = x + 0.5 - c, Y = y + 0.5 - c, h = -1, cov = 0;
            if (X * X + Y * Y > (half + rk + 2) * (half + rk + 2)) { H[i] = 0; A[i] = 0; continue; }
            for (var j = 0; j < 3; j++) {
                var ca = CA[j], sa = SA[j];
                var sx = X * ca + Y * sa, sy = -X * sa + Y * ca, ax = Math.abs(sx);
                var dbar = ax <= half ? Math.abs(sy) : Math.hypot(ax - half, sy);
                if (dbar < rb + 1) {
                    var q = Math.min(1, dbar / rb), hb = 0.05 * k + rb * Math.sqrt(1 - q * q);
                    if (hb > h) h = hb;
                    cov = Math.max(cov, clamp(rb - dbar + 0.5, 0, 1));
                }
                var dk = Math.hypot(ax - kx, sy);
                if (dk < rk + 1) {
                    var qk = Math.min(1, dk / rk), hk = 0.06 * k + rk * Math.sqrt(1 - qk * qk);
                    if (hk > h) h = hk;
                    cov = Math.max(cov, clamp(rk - dk + 0.5, 0, 1));
                }
            }
            var dh = Math.hypot(X, Y);
            if (dh < rh + 1) {
                var qh = Math.min(1, dh / rh), hh = 0.04 * k + 0.08 * k * Math.sqrt(1 - qh * qh);
                if (hh > h) h = hh;
                cov = Math.max(cov, clamp(rh - dh + 0.5, 0, 1));
            }
            H[i] = Math.max(0, h); A[i] = cov;
        }
        var Sh = blur(A, Cs, Cs, 0.018 * k, 2), out = new Uint8ClampedArray(N * 4);
        for (y = 1; y < Cs - 1; y++) for (x = 1; x < Cs - 1; x++) {
            i = y * Cs + x;
            var sxp = clamp(Math.round(x - SHX * shOff), 0, Cs - 1), syp = clamp(Math.round(y - SHY * shOff), 0, Cs - 1);
            var sh = Sh[syp * Cs + sxp] * 0.6;
            if (A[i] > 0) {
                var nx = -(H[i + 1] - H[i - 1]) * 0.5, ny = -(H[i + Cs] - H[i - Cs]) * 0.5, nl = Math.hypot(nx, ny, 1);
                shade(nx / nl, ny / nl, 1 / nl, 0.72, 0.73, 0.74, 0.06, 0, 0, 0, 1);
            } else { C[0] = C[1] = C[2] = 0; }
            writeOverShadow(out, i, A[i], sh);
        }
        frames.push({ w: Cs, h: Cs, data: out.buffer });
    }
    return frames;
}

/* ------------------------------------------------- porthole bezel + glass */

function renderRim(t) {
    var rd = t.rd, sc = t.scale, S = t.size, c = S / 2, N = S * S, x, y, i;
    var H = new Float32Array(N), A = new Float32Array(N), M = new Uint8Array(N);
    for (y = 0; y < S; y++) for (x = 0; x < S; x++) {
        i = y * S + x;
        var X = x + 0.5 - c, Y = y + 0.5 - c, r = Math.hypot(X, Y), tt = (r - rd) / sc, h = 0, mat = 3;
        if (tt < 0) { A[i] = 0; continue; }
        if (tt < 3) { h = 1; mat = 3; }
        else if (tt < 7) { h = 3 + 1.2 * Math.sin(Math.PI * (tt - 3) / 4) + 0.35 * Math.sin(Math.atan2(Y, X) * 110); mat = 1; }
        else if (tt < 9) { h = 2; mat = 3; }
        else { h = 3 * Math.cos(clamp((tt - 9) / 3, 0, 1) * Math.PI / 2); mat = 4; }
        H[i] = h * sc; M[i] = mat; A[i] = clamp(Math.min(r - rd, rd + 12 * sc - r) + 0.5, 0, 1);
    }
    var Sh = blur(A, S, S, 2 * sc, 2), out = new Uint8ClampedArray(N * 4), shOff = 3 * sc;
    for (y = 1; y < S - 1; y++) for (x = 1; x < S - 1; x++) {
        i = y * S + x;
        var X2 = x + 0.5 - c, Y2 = y + 0.5 - c, r2 = Math.hypot(X2, Y2);
        if (r2 < rd) {
            // glass over the photo: faint reflection of the studio plus an inner shadow
            var gx = X2 / rd * 0.22, gy = Y2 / rd * 0.22, gn = Math.hypot(gx, gy, 1);
            env(2 * gx / gn / gn, 2 * gy / gn / gn, 2 / (gn * gn) - 1, 0.02);
            var ra = clamp((E[0] + E[1] + E[2]) / 3 * 0.09, 0, 0.55);
            var inner = smooth(rd - 12 * sc, rd, r2) * 0.6, a = ra + inner * (1 - ra);
            var o = i * 4, kk = a > 0 ? ra / a : 0;
            out[o] = 255 * kk; out[o + 1] = 250 * kk; out[o + 2] = 240 * kk; out[o + 3] = a * 255;
            continue;
        }
        var sxp = clamp(Math.round(x - SHX * shOff), 0, S - 1), syp = clamp(Math.round(y - SHY * shOff), 0, S - 1);
        var sh = Sh[syp * S + sxp] * 0.55;
        if (A[i] > 0) {
            var nx = -(H[i + 1] - H[i - 1]) * 0.5, ny = -(H[i + S] - H[i - S]) * 0.5, nl = Math.hypot(nx, ny, 1), m = MAT[M[i]];
            shade(nx / nl, ny / nl, 1 / nl, m[0], m[1], m[2], m[3], -Y2 / r2, X2 / r2, m[4], 1);
        }
        writeOverShadow(out, i, A[i], sh);
    }
    return [{ w: S, h: S, data: out.buffer }];
}

/* ----------------------------------------------------------------- bolts */

// One sprite per bolt: each lies along its own radial direction, so it is lit
// in its rotated frame and the result is shown inside the rotated element.
function renderBolts(t) {
    var w = t.w, h = t.h, m = t.margin, Wc = Math.round(w + 2 * m), Hc = Math.round(h + 2 * m), res = [];
    var N = Wc * Hc, hw = w / 2, capY = -h / 2 + hw, shOff = 0.35 * w;
    for (var b = 0; b < t.angles.length; b++) {
        var a = t.angles[b] * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
        var H = new Float32Array(N), A = new Float32Array(N), x, y, i;
        for (y = 0; y < Hc; y++) for (x = 0; x < Wc; x++) {
            i = y * Wc + x;
            var X = x + 0.5 - Wc / 2, Y = y + 0.5 - Hc / 2, hh = 0, cov = 0;
            if (Y < capY) {
                var d = Math.hypot(X, Y - capY);
                cov = clamp(hw - d + 0.5, 0, 1);
                if (d < hw) hh = 0.2 * w + 0.4 * w * Math.sqrt(1 - (d / hw) * (d / hw));
            } else if (Y < h / 2) {
                cov = clamp(Math.min(hw - Math.abs(X), h / 2 - Y) + 0.5, 0, 1);
                var q = Math.min(1, Math.abs(X) / hw);
                hh = 0.2 * w + 0.4 * w * Math.sqrt(1 - q * q);
                hh *= 0.85 + 0.15 * smooth(0, 0.12 * w, h / 2 - Y);
                if (Math.abs(Y - (capY + 0.18 * w)) < 0.03 * w) hh -= 0.04 * w;
            }
            H[i] = hh; A[i] = cov;
        }
        var Sh = blur(A, Wc, Hc, 0.12 * w, 2), out = new Uint8ClampedArray(N * 4);
        // shadow direction expressed in the bolt's rotated frame
        var lsx = SHX * ca + SHY * sa, lsy = -SHX * sa + SHY * ca;
        for (y = 1; y < Hc - 1; y++) for (x = 1; x < Wc - 1; x++) {
            i = y * Wc + x;
            var sxp = clamp(Math.round(x - lsx * shOff), 0, Wc - 1), syp = clamp(Math.round(y - lsy * shOff), 0, Hc - 1);
            var sh = Sh[syp * Wc + sxp] * 0.65;
            if (A[i] > 0) {
                var nx = -(H[i + 1] - H[i - 1]) * 0.5, ny = -(H[i + Wc] - H[i - Wc]) * 0.5, nl = Math.hypot(nx, ny, 1);
                nx /= nl; ny /= nl;
                var line = x, bv = (hash(line * 7 + b) - 0.5) * 0.12;
                // rotate normal and brush direction into screen space before lighting
                shade(nx * ca - ny * sa, nx * sa + ny * ca, 1 / nl, 0.68 * (1 + bv), 0.69 * (1 + bv), 0.70 * (1 + bv), 0.14, -sa, ca, 0.7, 1);
            } else { C[0] = C[1] = C[2] = 0; }
            writeOverShadow(out, i, A[i], sh);
        }
        res.push({ w: Wc, h: Hc, data: out.buffer });
    }
    return res;
}

var RENDER = { door: renderDoor, frame: renderFrame, wall: renderWall, wheel: renderWheel, rim: renderRim, bolts: renderBolts };

self.onmessage = function (e) {
    var results = [], transfer = [];
    e.data.tasks.forEach(function (t) {
        var images = RENDER[t.kind](t);
        images.forEach(function (im) { transfer.push(im.data); });
        results.push({ kind: t.kind, images: images });
    });
    self.postMessage({ results: results }, transfer);
};
