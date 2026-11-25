import { type InferSelectModel } from "spacepress";
import { serviceActors } from "spacepress:db";
import { serviceActors as actorSchema } from "./schema";

export type ServiceActor = InferSelectModel<typeof actorSchema>;
export const serviceOffset = 4000000000000;

export async function serviceIdentity(id: number) {
  if (id <= serviceOffset) return null;
  return await serviceActors.system.get(id - serviceOffset);
}
