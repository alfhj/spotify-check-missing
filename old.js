const readline = require("node:readline");

const inputText = (prompt) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (token) => {
      resolve(token);
      rl.close();
    });
  });

const getToken = async () => {
  const credentials = await inputText("Client ID and secret separated by colon: ");
  const [clientId, clientSecret] = credentials.split(":");

  return await axios
    .post(
      "https://accounts.spotify.com/api/token",
      {
        grant_type: "client_credentials",
      },
      {
        Authorization: "Basic " + btoa(credentials),
        //auth: {
        //  username: clientId,
        //  password: clientSecret,
        //},
      }
    )
    .then((res) => res.data.access_token)
    .catch((error) => printError(error));
};

//const token = await inputText("Spotify API token: ");
//const token = await getToken();
