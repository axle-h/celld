import text from "./note.txt";
import data from "./blob.bin";
export default { fetch() { return new Response(text + data.byteLength); } };
