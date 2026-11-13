/** Local server: the same API and console the OpenServ container serves, without the agent. */
import "./sealed";
import express from "express";
import { mount } from "./routes";

const app = express();
mount(app);
const port = Number(process.env.PORT ?? 3300);
app.listen(port, () => console.log(`Bonded on http://localhost:${port}`));
