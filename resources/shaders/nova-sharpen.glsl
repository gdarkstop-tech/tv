// NOVA Vision Engine — contrast-adaptive sharpening.
// Original implementation for NOVA TV OS (MIT). The adaptive weighting follows
// the publicly documented idea behind AMD FidelityFX CAS: sharpen less where
// local contrast is already high so edges do not ring or clip.
// Runs after scaling so the cost scales with output resolution, not source.

//!PARAM nova_sharp
//!DESC NOVA sharpening strength (0 = off, 1 = strong)
//!TYPE float
//!MINIMUM 0.0
//!MAXIMUM 1.0
0.0

//!HOOK SCALED
//!BIND HOOKED
//!DESC NOVA contrast-adaptive sharpen

vec4 hook() {
    vec4 c = HOOKED_texOff(vec2(0.0, 0.0));
    vec3 n = HOOKED_texOff(vec2(0.0, -1.0)).rgb;
    vec3 s = HOOKED_texOff(vec2(0.0, 1.0)).rgb;
    vec3 e = HOOKED_texOff(vec2(1.0, 0.0)).rgb;
    vec3 w = HOOKED_texOff(vec2(-1.0, 0.0)).rgb;

    vec3 mn = min(c.rgb, min(min(n, s), min(e, w)));
    vec3 mx = max(c.rgb, max(max(n, s), max(e, w)));

    // Headroom before clipping on either side, relative to the local maximum.
    vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
    amp = sqrt(amp);

    // Negative lobe weight: -1/8 (gentle) .. -1/5 (strong).
    float peak = -1.0 / mix(8.0, 5.0, clamp(nova_sharp, 0.0, 1.0));
    vec3 wgt = amp * peak * clamp(nova_sharp * 4.0, 0.0, 1.0);

    vec3 outc = (c.rgb + (n + s + e + w) * wgt) / (1.0 + 4.0 * wgt);
    return vec4(clamp(outc, 0.0, 1.0), c.a);
}
