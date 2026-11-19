// Lightweight GLB loader + SkinnedMesh cloner for Three.js r128 (zero external deps)
(function (global) {
  'use strict';
  const T = global.THREE;
  if (!T) return;

  const COMP_MAP = {
    5120: [Int8Array, 1],
    5121: [Uint8Array, 1],
    5122: [Int16Array, 2],
    5123: [Uint16Array, 2],
    5125: [Uint32Array, 4],
    5126: [Float32Array, 4],
  };
  const TYPE_SIZE = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function readAccessor(gltf, binBuf, accIdx) {
    const acc = gltf.accessors[accIdx];
    const bv = gltf.bufferViews[acc.bufferView || 0];
    const [TypedArr, compBytes] = COMP_MAP[acc.componentType];
    const itemLen = TYPE_SIZE[acc.type];
    const byteOffset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const stride = bv.byteStride || 0;
    const count = acc.count;

    if (!stride || stride === itemLen * compBytes) {
      return new TypedArr(binBuf, byteOffset, count * itemLen);
    }
    const out = new TypedArr(count * itemLen);
    const dv = new DataView(binBuf);
    for (let i = 0; i < count; i++) {
      const base = byteOffset + i * stride;
      for (let j = 0; j < itemLen; j++) {
        const off = base + j * compBytes;
        switch (acc.componentType) {
          case 5126: out[i * itemLen + j] = dv.getFloat32(off, true); break;
          case 5123: out[i * itemLen + j] = dv.getUint16(off, true); break;
          case 5125: out[i * itemLen + j] = dv.getUint32(off, true); break;
          case 5121: out[i * itemLen + j] = dv.getUint8(off); break;
          case 5122: out[i * itemLen + j] = dv.getInt16(off, true); break;
          case 5120: out[i * itemLen + j] = dv.getInt8(off); break;
        }
      }
    }
    return out;
  }

  function loadImageFromBuffer(bytes, mime) {
    return new Promise((resolve) => {
      const blob = new Blob([bytes], { type: mime || 'image/png' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const tex = new T.Texture(img);
        tex.flipY = false;
        tex.needsUpdate = true;
        resolve(tex);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };
      img.src = url;
    });
  }

  async function parseGLB(arrayBuffer) {
    const dv = new DataView(arrayBuffer);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('Invalid GLB magic');
    let offset = 12;
    let gltf = null;
    let binBuf = null;
    while (offset < arrayBuffer.byteLength) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const chunkStart = offset + 8;
      if (chunkType === 0x4E4F534A) {
        const jsonStr = new TextDecoder('utf-8').decode(new Uint8Array(arrayBuffer, chunkStart, chunkLen));
        gltf = JSON.parse(jsonStr);
      } else if (chunkType === 0x004E4942) {
        binBuf = arrayBuffer.slice(chunkStart, chunkStart + chunkLen);
      }
      offset = chunkStart + chunkLen;
    }
    if (!gltf || !binBuf) throw new Error('Missing JSON or BIN chunk in GLB');

    // Load embedded textures
    const textures = [];
    const images = gltf.images || [];
    const texDefs = gltf.textures || [];
    const imgTexPromises = images.map((im) => {
      if (im.bufferView === undefined) return Promise.resolve(null);
      const bv = gltf.bufferViews[im.bufferView];
      const bytes = new Uint8Array(binBuf, bv.byteOffset || 0, bv.byteLength);
      return loadImageFromBuffer(bytes, im.mimeType);
    });
    const imgTextures = await Promise.all(imgTexPromises);
    for (let i = 0; i < texDefs.length; i++) {
      const srcIdx = texDefs[i].source;
      const tex = imgTextures[srcIdx] || null;
      if (tex) {
        tex.anisotropy = 4;
        tex.wrapS = tex.wrapT = T.RepeatWrapping;
      }
      textures.push(tex);
    }

    // Build materials
    const materials = (gltf.materials || []).map((md) => {
      const pbr = md.pbrMetallicRoughness || {};
      const params = {
        name: md.name || '',
        roughness: 0.88,
        metalness: 0.0,
        side: md.doubleSided ? T.DoubleSide : T.FrontSide,
      };
      if (pbr.baseColorFactor) {
        params.color = new T.Color(pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2]);
      }
      if (pbr.baseColorTexture && textures[pbr.baseColorTexture.index]) {
        params.map = textures[pbr.baseColorTexture.index];
      }
      if (md.emissiveFactor) {
        const ef = md.emissiveFactor;
        if (ef[0] || ef[1] || ef[2]) {
          params.emissive = new T.Color(ef[0], ef[1], ef[2]);
        }
      }
      return new T.MeshStandardMaterial(params);
    });
    const defaultMat = new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.65 });

    // Build geometries per mesh primitive
    function buildGeo(prim) {
      const g = new T.BufferGeometry();
      const attrs = prim.attributes || {};
      if (attrs.POSITION !== undefined) {
        g.setAttribute('position', new T.BufferAttribute(readAccessor(gltf, binBuf, attrs.POSITION), 3));
      }
      if (attrs.NORMAL !== undefined) {
        g.setAttribute('normal', new T.BufferAttribute(readAccessor(gltf, binBuf, attrs.NORMAL), 3));
      }
      if (attrs.TEXCOORD_0 !== undefined) {
        g.setAttribute('uv', new T.BufferAttribute(readAccessor(gltf, binBuf, attrs.TEXCOORD_0), 2));
      }
      if (attrs.JOINTS_0 !== undefined) {
        const arr = readAccessor(gltf, binBuf, attrs.JOINTS_0);
        g.setAttribute('skinIndex', new T.BufferAttribute(new Uint16Array(arr), 4));
      }
      if (attrs.WEIGHTS_0 !== undefined) {
        const acc = gltf.accessors[attrs.WEIGHTS_0];
        let arr = readAccessor(gltf, binBuf, attrs.WEIGHTS_0);
        if (acc.normalized && !(arr instanceof Float32Array)) {
          const div = acc.componentType === 5121 ? 255 : 65535;
          const f = new Float32Array(arr.length);
          for (let i = 0; i < arr.length; i++) f[i] = arr[i] / div;
          arr = f;
        }
        g.setAttribute('skinWeight', new T.BufferAttribute(arr, 4));
      }
      if (prim.indices !== undefined) {
        const idxArr = readAccessor(gltf, binBuf, prim.indices);
        g.setIndex(new T.BufferAttribute(idxArr, 1));
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      return g;
    }

    // Build nodes
    const nodes = gltf.nodes || [];
    const nodeObjs = [];
    const pendingSkins = [];

    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      let obj;
      if (nd.mesh !== undefined) {
        const mDef = gltf.meshes[nd.mesh];
        const prims = mDef.primitives || [];
        const hasSkin = nd.skin !== undefined;
        if (prims.length === 1) {
          const g = buildGeo(prims[0]);
          const mat = prims[0].material !== undefined ? materials[prims[0].material] : defaultMat;
          if (hasSkin) mat.skinning = true;
          obj = hasSkin ? new T.SkinnedMesh(g, mat) : new T.Mesh(g, mat);
          obj.castShadow = true;
          if (hasSkin) pendingSkins.push({ mesh: obj, skinIdx: nd.skin });
        } else {
          obj = new T.Group();
          for (const pr of prims) {
            const g = buildGeo(pr);
            const mat = pr.material !== undefined ? materials[pr.material] : defaultMat;
            if (hasSkin) mat.skinning = true;
            const sub = hasSkin ? new T.SkinnedMesh(g, mat) : new T.Mesh(g, mat);
            sub.castShadow = true;
            if (hasSkin) pendingSkins.push({ mesh: sub, skinIdx: nd.skin });
            obj.add(sub);
          }
        }
      } else {
        obj = new T.Group();
      }
      obj.name = nd.name || '';
      if (nd.matrix) {
        const m = new T.Matrix4().fromArray(nd.matrix);
        m.decompose(obj.position, obj.quaternion, obj.scale);
      } else {
        if (nd.translation) obj.position.fromArray(nd.translation);
        if (nd.rotation) obj.quaternion.fromArray(nd.rotation);
        if (nd.scale) obj.scale.fromArray(nd.scale);
      }
      nodeObjs.push(obj);
    }

    // Parent-child hierarchy
    for (let i = 0; i < nodes.length; i++) {
      const ch = nodes[i].children;
      if (!ch) continue;
      for (const cIdx of ch) {
        nodeObjs[i].add(nodeObjs[cIdx]);
      }
    }

    // Bind skins
    const skins = gltf.skins || [];
    for (const ps of pendingSkins) {
      const sk = skins[ps.skinIdx];
      const bones = sk.joints.map((j) => nodeObjs[j]);
      const invArr = sk.inverseBindMatrices !== undefined ? readAccessor(gltf, binBuf, sk.inverseBindMatrices) : null;
      const boneInverses = [];
      for (let i = 0; i < bones.length; i++) {
        const m = new T.Matrix4();
        if (invArr) m.fromArray(invArr, i * 16);
        boneInverses.push(m);
      }
      ps.mesh.updateMatrixWorld(true);
      const skeleton = new T.Skeleton(bones, boneInverses);
      ps.mesh.bind(skeleton, ps.mesh.matrixWorld);
    }

    const sceneDef = (gltf.scenes || [])[gltf.scene || 0] || { nodes: [] };
    const root = new T.Group();
    for (const nIdx of sceneDef.nodes || []) {
      root.add(nodeObjs[nIdx]);
    }
    return root;
  }

  function cloneSkinned(source) {
    const sourceLookup = new Map();
    const cloneLookup = new Map();

    const cloneNode = (src) => {
      let dst;
      if (src.isSkinnedMesh) {
        dst = new T.SkinnedMesh(src.geometry, src.material);
        dst.castShadow = src.castShadow;
        dst.receiveShadow = src.receiveShadow;
      } else if (src.isMesh) {
        dst = new T.Mesh(src.geometry, src.material);
        dst.castShadow = src.castShadow;
        dst.receiveShadow = src.receiveShadow;
      } else if (src.isBone) {
        dst = new T.Bone();
      } else {
        dst = new T.Group();
      }
      dst.name = src.name;
      dst.position.copy(src.position);
      dst.quaternion.copy(src.quaternion);
      dst.scale.copy(src.scale);
      dst.visible = src.visible;
      sourceLookup.set(dst, src);
      cloneLookup.set(src, dst);
      for (let i = 0; i < src.children.length; i++) {
        dst.add(cloneNode(src.children[i]));
      }
      return dst;
    };

    const root = cloneNode(source);
    root.updateMatrixWorld(true);

    root.traverse((dst) => {
      if (!dst.isSkinnedMesh) return;
      const src = sourceLookup.get(dst);
      const srcSkel = src.skeleton;
      const bones = srcSkel.bones.map((b) => cloneLookup.get(b) || b);
      const newSkel = new T.Skeleton(bones, srcSkel.boneInverses);
      dst.bind(newSkel, src.bindMatrix);
    });

    return root;
  }

  global.GLTFLite = {
    load: async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      const buf = await res.arrayBuffer();
      return parseGLB(buf);
    },
    parse: parseGLB,
    cloneSkinned,
  };
})(window);
