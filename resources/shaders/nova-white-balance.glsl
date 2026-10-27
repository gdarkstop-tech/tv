// NOVA Vision Engine — colour temperature (white balance) adjustment.
// Original implementation for NOVA TV OS (MIT).
// nova_temp < 0 warms the image (towards ~5000 K), > 0 cools it (towards
// ~9300 K). Gains are normalised so the strongest channel stays at 1.0,
// which means the adjustment can never clip highlights.
// Gains are defined in linear light and converted for the gamma-encoded
// output (approximate 2.2 power law), so neutral greys stay neutral in hue.

//!PARAM nova_temp
//!DESC NOVA colour temperature (-1 warm .. 1 cool)
//!TYPE float
//!MINIMUM -1.0
//!MAXIMUM 1.0
0.0

//!HOOK OUTPUT
//!BIND HOOKED
//!DESC NOVA white balance

vec4 hook() {
    vec4 c = HOOKED_texOff(vec2(0.0, 0.0));
    float t = clamp(nova_temp, -1.0, 1.0);
    vec3 gainLinear;
    if (t < 0.0) {
        float k = -t;
        gainLinear = vec3(1.0, 1.0 - 0.07 * k, 1.0 - 0.22 * k);
    } else {
        gainLinear = vec3(1.0 - 0.18 * t, 1.0 - 0.06 * t, 1.0);
    }
    vec3 gainEncoded = pow(gainLinear, vec3(1.0 / 2.2));
    return vec4(clamp(c.rgb * gainEncoded, 0.0, 1.0), c.a);
}
