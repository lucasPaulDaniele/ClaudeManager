/**
 * LIRE LE CONTENU REEL D'UN ARTEFACT — sans y ajouter la moindre dependance.
 *
 * Un VSIX est un ZIP, un paquet npm est un TAR gzippe. Les deux se lisent avec `node:zlib` et
 * quelques deplacements d'octets ; en ajouter une bibliotheque ferait dependre la verification
 * d'un tiers qu'il faudrait ensuite verifier a son tour.
 *
 * Ces lecteurs ne DECOMPRESSENT rien du ZIP : ils lisent l'ANNUAIRE CENTRAL, qui porte les
 * noms et les tailles. Pour le contenu octet a octet — dont on a besoin pour juger la
 * reproductibilite —, `entriesWithContent` decompresse.
 *
 * PRECAUTION : ces lecteurs ne servent QU'A verifier nos propres artefacts, produits a la
 * ligne precedente par `npm run package:all`. Ils ne sont pas ecrits pour resister a une
 * archive hostile, et n'ont pas a l'etre.
 */

import { gunzipSync, inflateRawSync } from 'node:zlib';

/** Une entree d'archive : son nom, et son contenu quand on l'a demande. */
export interface ArchiveEntry {
  readonly name: string;
  readonly content: Buffer;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;

/** Position de l'annuaire central, trouvee en remontant depuis la fin. */
function findCentralDirectory(zip: Buffer): { offset: number; count: number } {
  // Le commentaire final peut faire jusqu'a 65 535 octets ; au-dela, l'archive est invalide.
  const floor = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= floor; i -= 1) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      return { offset: zip.readUInt32LE(i + 16), count: zip.readUInt16LE(i + 10) };
    }
  }
  throw new Error("ZIP invalide : aucun annuaire central (l'archive est-elle tronquee ?)");
}

/**
 * Les entrees d'un ZIP, contenu compris.
 *
 * Le contenu est lu depuis l'en-tete LOCAL de chaque entree, dont l'annuaire central donne le
 * decalage. Seules les methodes 0 (stockee) et 8 (deflate) sont traitees : ce sont les deux
 * que `vsce` emet.
 */
export function readZipEntries(zip: Buffer): readonly ArchiveEntry[] {
  const { offset, count } = findCentralDirectory(zip);
  const entries: ArchiveEntry[] = [];
  let cursor = offset;

  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error(`ZIP invalide : entree d'annuaire ${i} malformee`);
    }
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    // En-tete local : 30 octets fixes, puis nom et extra — dont les longueurs peuvent differer
    // de celles de l'annuaire, d'ou une relecture sur place plutot qu'une reutilisation.
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`ZIP : methode de compression ${method} non traitee pour « ${name} »`);

    entries.push({ name, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Les entrees d'un `.tgz` npm, contenu compris.
 *
 * Format tar : des blocs de 512 octets, chaque fichier precede d'un en-tete portant son nom
 * (offset 0), sa taille en octal (offset 124) et son type (offset 156). Les en-tetes
 * d'extension `pax` (types `x` et `g`) sont ignores : npm ne les emet que pour des noms tres
 * longs, et un nom tronque produirait une violation visible plutot qu'un silence.
 */
export function readTarGzEntries(tgz: Buffer): readonly ArchiveEntry[] {
  const tar = gunzipSync(tgz);
  const entries: ArchiveEntry[] = [];

  for (let offset = 0; offset + 512 <= tar.length; ) {
    const nameField = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/, '');
    // Deux blocs vides consecutifs marquent la fin de l'archive.
    if (nameField === '') break;

    const sizeField = tar.toString('utf8', offset + 124, offset + 136).replace(/\0.*$/, '').trim();
    const size = Number.parseInt(sizeField, 8);
    const type = tar.toString('utf8', offset + 156, offset + 157);
    const dataStart = offset + 512;

    // Type '0' ou '\0' : fichier ordinaire. Le reste (repertoires, pax, liens) est saute.
    if (type === '0' || type === '\0') {
      entries.push({ name: nameField, content: tar.subarray(dataStart, dataStart + size) });
    }

    // Le contenu est complete jusqu'au prochain multiple de 512.
    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

/** Les noms seuls, pour ce qui ne juge que la composition de l'archive. */
export function namesOf(entries: readonly ArchiveEntry[]): readonly string[] {
  return entries.map((e) => e.name);
}
