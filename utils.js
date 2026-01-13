export function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.z - p2.z, 2));
}

// Check if point P is strictly within a rectangle defined by Center C, Width W, Height H, and rotation Angle
export class SeededRandom {
    constructor(seed) {
        this.seed = seed || 123456;
    }

    // Mulberry32
    next() {
        let t = this.seed += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    
    // Range [min, max)
    range(min, max) {
        return min + this.next() * (max - min);
    }
}

export function isPointOnOBB(point, center, width, height, angle) {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Translate point to local space
    const dx = point.x - center.x;
    const dz = point.z - center.z;

    // Rotate point to axis aligned
    const localX = dx * cos - dz * sin;
    const localZ = dx * sin + dz * cos;

    return Math.abs(localX) <= width / 2 && Math.abs(localZ) <= height / 2;
}