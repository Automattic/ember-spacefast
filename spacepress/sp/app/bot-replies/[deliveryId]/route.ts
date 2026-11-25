import { type RouteRequest } from "spacepress";
import { botReply } from "../../../service-delivery";

export const guard = "anyone";

export async function POST(request: RouteRequest) {
  return await botReply(request);
}
