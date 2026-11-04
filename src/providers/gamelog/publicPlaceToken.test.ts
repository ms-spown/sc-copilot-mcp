import { describe, expect, it } from "vitest";
import { parseShipLine, publicPlaceToken } from "./shipLossParse.js";

/**
 * publicPlaceToken decides which place a log token may be used as a position: the game's own place families with no private word
 * ANYWHERE in them. The ship-loss reader keeps its own, narrower rule, unchanged. Every token below is made up.
 */

describe("Feature: a place token that may be used as a position", () => {
  it("Given the game's own place names, Then they are public and returned as they are", () => {
    for (const token of [
      "Stanton1_Lorville",
      "Stanton2_Area18",
      "OOC_Stanton_3a_Lyria",
      "Stanton1_Lorville_Tressler",
    ]) {
      expect(publicPlaceToken(token), token).toBe(token);
    }
  });

  it("Given a private word at the START of a segment, Then it is not a place", () => {
    for (const token of [
      "Hangar_SomePlayer",
      "Apartment_SomePlayer_Home",
      "Orison_Hangar_SomePlayer",
      "Stanton1_Lorville_Room",
    ]) {
      expect(publicPlaceToken(token), token).toBeNull();
    }
  });

  it("Given a private word INSIDE a segment (PlayerHangar, JohnsHome), Then it is not a place either", () => {
    for (const token of [
      "PlayerHangar",
      "Orison_PlayerHangar",
      "Stanton1_Lorville_JohnsHome",
      "Stanton1_Lorville_PlayerHangar",
      "Stanton1_Lorville_Mushroom",
      "Stanton1_Lorville_Residence",
      "Stanton1_Lorville_CrewQuarters",
      "Stanton1_Lorville_SmallCabin",
      "Stanton1_Lorville_Locker",
      "Stanton1_Lorville_Bunk",
      "Stanton1_Lorville_HABITAT",
      "stanton1_lorville_johnshome",
    ]) {
      expect(publicPlaceToken(token), token).toBeNull();
    }
  });

  it("Given a family followed by a handle-like segment, Then a handle with a long number is dropped, and nothing else is guessed", () => {
    expect(publicPlaceToken("Stanton1_Lorville_Spown12345")).toBeNull();
    expect(publicPlaceToken("Stanton1_Lorville_Spown_Hangar")).toBeNull();
    expect(publicPlaceToken(undefined)).toBeNull();
    expect(publicPlaceToken("")).toBeNull();
  });
});

describe("Feature: the ship-loss reader keeps its own rule", () => {
  const ts = "2026-11-03T20:00:00.000Z";
  const collision = (zone: string) =>
    `<FatalCollision> Fatal Collision occured for vehicle MISC_Freelancer_700000000555 [Part: Nose, Pos: x: 1.5, y: -2.5, z: 3.5, Zone: ${zone}, PlayerPilot: 1] after hitting entity: SomeRock_X`;
  const zoneOf = (zone: string) => {
    const r = parseShipLine(collision(zone), ts, { playerRef: null });
    return r && r.kind === "collision" ? r.zone : "no record";
  };

  it("Given zones the ship-loss rule always kept or dropped, Then it still does, byte for byte", () => {
    // Kept: a family with ordinary segments, and a private word that is not at the start of a segment.
    expect(zoneOf("OOC_Stanton_3a_Lyria")).toBe("OOC_Stanton_3a_Lyria");
    expect(zoneOf("Stanton1_Lorville_JohnsHome")).toBe("Stanton1_Lorville_JohnsHome");
    // Dropped: a private word at the start of a segment, and anything that is no place family.
    expect(zoneOf("Orison_Hangar_SomePlayer")).toBeNull();
    expect(zoneOf("Whatever_Thing")).toBeNull();
  });
});
