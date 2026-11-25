import { type RouteRequest } from "spacepress";
import { slackWebhook } from "../../../../../../service-delivery";

export const guard = "anyone";

export async function POST(request: RouteRequest) {
  return await slackWebhook(request);
}
