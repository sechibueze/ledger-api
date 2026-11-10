import "dotenv/config";
import { app } from "./app";

const port = Number(process.env.PORT ?? 4010);
app.listen(port, () => console.log(`ledger listening on :${port}`));
