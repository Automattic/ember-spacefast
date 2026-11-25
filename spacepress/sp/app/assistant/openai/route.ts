import { type RouteRequest } from "spacepress";
import { assistantWebhook } from "../../../service-delivery";

export const guard = "anyone";

export async function POST(request: RouteRequest) {
  return await assistantWebhook(request);
}
