"use strict";

/**
 * GBDS asks for a distance by node index (id_in_project), not by coordinate,
 * so the driver resolves indices to GPS itself via GET /project/:id/nodes.
 *
 * Axis mapping: x_coord is longitude, y_coord is latitude.
 */
class NodeDirectory {
  #httpUrl;
  #apiKey;
  #projectId;
  #timeoutMs;
  #byId = new Map();
  #loaded = false;
  #loading = null;

  constructor({ httpUrl, apiKey, projectId, timeoutMs }) {
    this.#httpUrl = httpUrl;
    this.#apiKey = apiKey;
    this.#projectId = projectId;
    this.#timeoutMs = timeoutMs;
  }

  get url() {
    return `${this.#httpUrl}/project/${this.#projectId}/nodes`;
  }

  /**
   * Concurrent callers share one in-flight fetch. GBDS asks for every edge at
   * once when the driver connects, so without this the first burst would fire
   * one node lookup per edge.
   */
  async load({ force = false } = {}) {
    if (this.#loaded && !force) return;
    if (!this.#loading) {
      this.#loading = this.#fetchNodes()
        .then((byId) => {
          this.#byId = byId;
          this.#loaded = true;
        })
        .finally(() => {
          this.#loading = null;
        });
    }
    await this.#loading;
  }

  async #fetchNodes() {
    let response;
    try {
      response = await fetch(this.url, {
        headers: { "x-api-key": this.#apiKey, accept: "application/json" },
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (err) {
      throw new Error(`GET ${this.url} failed: ${err.message}`);
    }
    if (!response.ok) {
      throw new Error(`GET ${this.url} returned HTTP ${response.status}`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows)) {
      throw new Error(`GET ${this.url} did not return an array of nodes`);
    }

    const byId = new Map();
    for (const row of rows) {
      byId.set(Number(row.id_in_project), {
        idInProject: Number(row.id_in_project),
        lng: Number(row.x_coord),
        lat: Number(row.y_coord),
      });
    }
    return byId;
  }

  /** Resolved GPS for a node index, or a throw explaining why not. */
  async coordsFor(idInProject) {
    const id = Number(idInProject);
    if (!Number.isInteger(id)) {
      throw new Error(`node index "${idInProject}" is not an integer`);
    }

    await this.load();
    let node = this.#byId.get(id);
    if (!node) {
      // The node may have been created since the last fetch.
      await this.load({ force: true });
      node = this.#byId.get(id);
    }
    if (!node) {
      throw new Error(`node ${id} does not exist in project ${this.#projectId}`);
    }

    const { lat, lng } = node;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new Error(`node ${id} has non-numeric coordinates (x=${lng}, y=${lat})`);
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      // GBDS stores x_coord/y_coord as plain REALs and its web client treats
      // them as canvas positions, so this is the likely failure when a project
      // holds drawing coordinates rather than GPS.
      throw new Error(
        `node ${id} is at x=${lng}, y=${lat}, which is not a GPS position ` +
          "(expected x_coord = longitude in [-180,180], y_coord = latitude in [-90,90])",
      );
    }

    return { lat, lng };
  }
}

module.exports = { NodeDirectory };
