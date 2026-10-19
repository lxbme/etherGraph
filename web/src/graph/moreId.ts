/** Id prefix of the "+N more" proxy nodes (and of their edges, with `more-edge:`); never a real address. */
export const MORE_PREFIX = "more:";
export const isMoreId = (id: string): boolean => id.startsWith(MORE_PREFIX) || id.startsWith("more-edge:");
