const express = require("express");
const axios = require("axios");

const app = express();

app.use(express.json());

const PORT = process.argv[2];
const NAME = process.argv[3];

const MIDDLEWARE_URL = "http://localhost:3000";

let pulseInterval;

// ROOT
app.get("/", (req, res) => {
  res.send(`Server  running on port ${PORT}`);
});

// SHUTDOWN
app.post("/shutdown", (req, res) => {
  if (pulseInterval) {
    clearInterval(pulseInterval);
    pulseInterval = null;
    console.log("Dejo de enviar pulsos");
  }

  res.json({ message: `${NAME} dejo de enviar pulsos` });
});

// SERVER
app.listen(PORT, async () => {
  console.log(`Server corriendo en http://localhost:${PORT}`);

  try {
    await axios.post(`${MIDDLEWARE_URL}/register`, {
      name: NAME,
      url: `http://localhost:${PORT}`,
    });

    console.log("Registrado sog");

    pulseInterval = setInterval(async () => {
      try {
        await axios.post(`${MIDDLEWARE_URL}/heartbeat/${NAME}`);
        console.log("Pulso enviado");
      } catch (error) {
        console.log("Error al enviar pulso");
      }
    }, 5000);
  } catch (error) {
    console.error("Error al registrar sog");
  }
});

// ENVIAR MENSAJE
app.post("/send-message", async (req, res) => {
  const { message } = req.body;

  // Validar mensaje
  if (!message) {
    return res.status(400).json({
      success: false,

      error: "Message required",
    });
  }

  console.log(`Enviando mensaje: "${message}"`);

  try {
    const response = await axios.post(
      `${MIDDLEWARE_URL}/send-message/${NAME}`,

      {
        message: message,
      },
    );

    console.log("Mensaje enviado correctamente");

    res.status(200).json({
      success: true,

      message: "Mensaje enviado correctamente",

      serverResponse: response.data,
    });
  } catch (error) {
    console.log("Error al enviar mensaje");

    res.status(503).json({
      success: false,

      message: "No se pudo entregar el mensaje",
    });
  }
});
