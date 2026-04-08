import { Starcite } from "@starcite/sdk";

/** One client for the whole server: lifecycle listeners and session mint must share this. */
export const starcite = new Starcite();
