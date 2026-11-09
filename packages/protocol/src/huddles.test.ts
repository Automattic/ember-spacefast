import { describe, expect, it } from "vitest";
import { APP_ID_REFUSED, APP_SECRET_REFUSED, appIdOf, appSecretOf, parseHuddlesSetup } from "./huddles";

const APP_ID = "2a95132c15732412d22c1476fa83f27a";
const APP_SECRET = "66bcf64aa8907b9f9d90ac17746a77ce394c393b92b3916633dc02846e608ad4";

describe("Set up huddles", () => {
  it("takes an SFU app's ID and its secret, without the spaces around them", () => {
    expect(parseHuddlesSetup({ appId: ` ${APP_ID}\n`, appSecret: `\t${APP_SECRET} ` })).toEqual({ appId: APP_ID, appSecret: APP_SECRET });
    // As they're given, whatever case their letters are in.
    expect(appIdOf(APP_ID.toUpperCase())).toBe(APP_ID.toUpperCase());
    expect(appSecretOf(APP_SECRET.toUpperCase())).toBe(APP_SECRET.toUpperCase());
  });

  it("refuses an App ID that can't be one, on its field", () => {
    const refused = { error: APP_ID_REFUSED, field: "appId" };
    for (const appId of ["", "   ", APP_ID.slice(1), `${APP_ID}0`, `${APP_ID.slice(0, 31)}/`, `${APP_ID.slice(0, 31)}é`, APP_SECRET, 42, null, undefined]) {
      expect(parseHuddlesSetup({ appId, appSecret: APP_SECRET }), JSON.stringify(appId)).toEqual(refused);
    }
    for (const data of [null, undefined, "keys", [APP_ID, APP_SECRET], 7]) expect(parseHuddlesSetup(data), JSON.stringify(data)).toEqual(refused);
  });

  it("refuses an App Secret that can't be one, on its field", () => {
    const refused = { error: APP_SECRET_REFUSED, field: "appSecret" };
    for (const appSecret of ["", APP_SECRET.slice(1), `${APP_SECRET}0`, `${APP_SECRET.slice(0, 63)}.`, `${APP_SECRET.slice(0, 32)} ${APP_SECRET.slice(33)}`, APP_ID, 42, null, undefined]) {
      expect(parseHuddlesSetup({ appId: APP_ID, appSecret }), JSON.stringify(appSecret)).toEqual(refused);
    }
  });
});
